"""Nexlify Board: Transition Rules, the move check, the Flow and Confirm Views.

Works on any DocType and depends on no other app. Another app plugs in through data on the
site, never through code: a row in Nexlify Board Settings can turn the move check on for a
DocType and name a method that gives the Flow its steps, and a Transition Rule can name a
method that shows a screen before a move (Confirm View). Those methods can be whitelisted
Python or API Server Scripts.

Transition Rules: what a document needs before its stage field moves, and who may move it.

A rule fires when the stage field leaves `From` (empty = any value) for `To` (empty = any
value). It can ask for fields, and it can ask for a Condition (a Python expression) to be
true; a failed condition shows the rule's Message with an optional Action button.

Who may move (Allowed Roles, Allowed Users, or the user a field of the document names): checked on
every save before the document's own validation (doc_events "*" before_validate), so it judges
the stage the user asked for even when the document's controller moves it on (e.g. to the stage
an action leads to). Rules that match a move must all let the user make it; within a rule, any
of its roles, users or its user field is enough. A rule with none of them holds no one. A save
made by code for the system (doc.flags.ignore_permissions) and the rule's bypass role are not
held, nor is a new document unless the rule says Apply on Create. Direction narrows a rule to
moves forward or backward in the board's column order.

The rule is checked on every save (doc_events "*" validate), so Kanban drags, List bulk
edits, the API, Data Import and scripts all obey it. The desk asks the same functions
which fields to show in its popup, so the popup and the server never disagree.

Before a Kanban drag, `check_move(dry_run=1)` also runs the document's validations
(Server Scripts, controllers, other apps) without saving, so any error appears on the
board with its action buttons. Action buttons are plain HTML any message can carry:

	<button data-nx-action="form">Open</button>
	<button data-nx-action="route:/app/quotation/new">New Quotation</button>
	<button data-nx-action="map:erpnext.crm.doctype.opportunity.opportunity.make_quotation">Quotation</button>
	<button data-nx-action="set_margin">Set Margin</button>   (registered by a Client Script)
"""

import re

import frappe
from frappe import _
from frappe.utils import cint, cstr, escape_html, flt, strip_html

CACHE_KEY = "nexlify_transition_rules"
SETTINGS_KEY = "nexlify_board_settings"


class TransitionRuleError(frappe.ValidationError):
	pass


class MoveNotAllowed(TransitionRuleError):
	"""The user may not make this move (the rule's Who May Move)."""


def clear_cache():
	frappe.cache.delete_value(CACHE_KEY)
	frappe.cache.delete_value(SETTINGS_KEY)


def get_settings(doctype):
	"""This DocType's row in Nexlify Board Settings: {check_moves, flow_method, blocked_move}, or {}."""
	return (frappe.cache.get_value(SETTINGS_KEY, generator=_load_settings) or {}).get(doctype) or {}


def _load_settings():
	if not frappe.db.table_exists("Nexlify Board DocType"):
		return {}
	columns = {c.lower() for c in frappe.db.get_table_columns("Nexlify Board DocType")}
	fields = ["reference_doctype", "check_moves", "flow_method"]
	fields += [c for c in ("blocked_move",) if c in columns]  # before migrate
	rows = frappe.get_all(
		"Nexlify Board DocType",
		filters={"parent": "Nexlify Board Settings", "parenttype": "Nexlify Board Settings"},
		fields=fields,
	)
	return {
		r.reference_doctype: {
			"check_moves": cint(r.check_moves),
			"flow_method": (r.flow_method or "").strip(),
			"blocked_move": r.get("blocked_move") or "Flow",
		}
		for r in rows
	}


def call_method(method, **kwargs):
	"""Call a whitelisted Python method or an API Server Script with `kwargs`.
	A Server Script answers through frappe.flags.result."""
	from frappe.core.doctype.server_script.server_script_utils import get_server_script_map
	from frappe.utils.safe_exec import call_whitelisted_function

	if get_server_script_map().get("_api", {}).get(method):
		out = call_whitelisted_function(method, **kwargs)
	else:
		# a Python method is called directly: the HTTP-method check of a web call doesn't apply
		# here (and fails outside a request, e.g. in bench execute)
		fn = frappe.get_attr(method)
		frappe.is_whitelisted(fn)
		out = fn(**kwargs)
	if isinstance(out, dict) and "result" in out:
		out = out.get("result")
	return out


def get_rules(doctype):
	"""Enabled rules of a DocType, cached until a rule changes."""
	return (frappe.cache.get_value(CACHE_KEY, generator=_load_rules) or {}).get(doctype, [])


def _load_rules():
	if not frappe.db.table_exists("Transition Rule"):
		return {}
	rows = frappe.get_all(
		"Transition Rule Field",
		filters={"parenttype": "Transition Rule"},
		fields=["parent", "fieldname", "condition"],
		order_by="idx asc",
	)
	fields = {}
	for row in rows:
		fields.setdefault(row.parent, []).append(
			frappe._dict(fieldname=row.fieldname, condition=(row.condition or "").strip())
		)
	columns = {c.lower() for c in frappe.db.get_table_columns("Transition Rule")}
	wanted = ["name", "creation", "reference_doctype", "stage_field", "from_value", "to_value", "message", "bypass_role", "open_form"]
	optional = ("condition", "action", "action_label", "step_label", "waiting_on", "sequence", "confirm_view", "confirm_label",
				"user_field", "direction", "apply_on_create", "refusal_message")
	wanted += [c for c in optional if c in columns]  # before migrate
	out = {}
	rules = frappe.get_all("Transition Rule", filters={"enabled": 1}, fields=wanted)
	rules.sort(key=lambda r: (cint(r.get("sequence")), r.creation))  # creation: the order they were added
	who = {}
	for child, column in (("Transition Rule Role", "role"), ("Transition Rule User", "user")):
		if not frappe.db.table_exists(child):  # before migrate
			continue
		for row in frappe.get_all(child, filters={"parenttype": "Transition Rule"}, fields=["parent", column]):
			who.setdefault(row.parent, {}).setdefault(column, []).append(row[column])
	for rule in rules:
		rule.fields = fields.get(rule.name, [])
		rule.condition = (rule.get("condition") or "").strip()
		rule.allowed_roles = who.get(rule.name, {}).get("role", [])
		rule.allowed_users = who.get(rule.name, {}).get("user", [])
		out.setdefault(rule.reference_doctype, []).append(rule)
	return out


def applicable_rules(rules, field, old, new):
	"""Rules that fire when `field` changes from `old` to `new` (old is None for a new document)."""
	out, roles = [], None
	for rule in rules:
		if rule.stage_field != field or cstr(old) == cstr(new):
			continue
		if rule.to_value and cstr(new) != cstr(rule.to_value):
			continue
		if rule.from_value and cstr(old) != cstr(rule.from_value):
			continue
		if rule.bypass_role:
			roles = roles or set(frappe.get_roles())
			if rule.bypass_role in roles:
				continue
		out.append(rule)
	return out


def is_empty(value, df=None):
	if df and df.fieldtype in ("Check", "Int", "Float", "Currency", "Percent"):
		return not flt(value)
	if isinstance(value, list | tuple):
		return not value
	text = cstr(value)
	return not strip_html(text).strip() and "<img" not in text


# ---------- conditions ----------


def _read_only_db():
	"""What a condition may ask the database: read-only, no permission checks (rules are set by admins)."""
	return frappe._dict(
		exists=frappe.db.exists,
		get_value=frappe.db.get_value,
		count=frappe.db.count,
		get_all=lambda *a, **kw: frappe.get_all(*a, **kw),
	)


# safe_eval has no builtins; these pure helpers make sums and checks over child tables possible
HELPERS = {"len": len, "sum": sum, "all": all, "any": any, "min": min, "max": max, "abs": abs, "bool": bool,
           "flt": flt, "cint": cint, "cstr": cstr}


class DocView(dict):
	"""The document as conditions see it: `doc.items` is the Items table, not dict.items.
	A field the document doesn't have reads as None; `doc.get("field")` works too."""

	def __getattribute__(self, name):
		if dict.__contains__(self, name):
			return dict.__getitem__(self, name)
		if name == "get":
			return object.__getattribute__(self, name)
		return None


def _view(data):
	def child(v):
		return _view(v) if isinstance(v, dict) else v

	return DocView({k: ([child(c) for c in v] if isinstance(v, list) else v) for k, v in dict(data).items()})


def evaluate(condition, data):
	"""Evaluate a condition with `doc` (the document after the move), `frappe.db` (read-only)
	and HELPERS. Raises on a broken expression."""
	scope = dict(HELPERS)
	scope["frappe"] = frappe._dict(db=_read_only_db(), session=frappe._dict(user=frappe.session.user))
	return bool(frappe.safe_eval(condition, scope, {"doc": _view(data)}))


def condition_met(condition, data):
	"""For required-field rows: a broken condition means "not required"."""
	if not condition:
		return True
	try:
		return evaluate(condition, data)
	except Exception:
		return False


def failed_conditions(rules, data):
	"""Rules whose Condition is false, in Sequence order. A broken Condition blocks the move and is logged."""
	out = []
	for rule in rules:
		if not rule.condition:
			continue
		try:
			ok = evaluate(rule.condition, data)
		except Exception:
			frappe.log_error(title=f"Transition Rule {rule.name}: condition failed")
			ok = False
		if not ok:
			out.append(rule)
	return out


def missing_fields(doc, rules, data, meta):
	"""Fields `doc` lacks for `rules`; conditions read `data` (the doc after the move)."""
	out = []
	for rule in rules:
		for f in rule.fields:
			if f.fieldname in out or not is_empty(doc.get(f.fieldname), meta.get_field(f.fieldname)):
				continue
			if condition_met(f.condition, data):
				out.append(f.fieldname)
	return out


# ---------- action buttons ----------


def action_button(action, label=None, doctype=None, name=None):
	"""HTML for a button the desk turns into `action` (see the module docstring)."""
	attrs = f'data-nx-action="{escape_html(action)}"'
	if doctype and name:
		attrs += f' data-doctype="{escape_html(doctype)}" data-name="{escape_html(name)}"'
	label = escape_html(_(label) if label else _("Open"))
	return f'<button class="btn btn-xs btn-primary nx-action" {attrs}>{label}</button>'


def condition_message(doc, field, rule):
	stage = _(cstr(doc.get(field)))
	message = _(rule.message) if rule.message else _("This move is not allowed yet.")
	if rule.get("action"):
		message += "<br><br>" + action_button(rule.action, rule.get("action_label"), doc.doctype, doc.name)
	title = _("Cannot move to {0}").format(stage) if stage else _("Cannot move")
	return message, title


# ---------- who may move ----------


def holds_who(rule):
	return bool(rule.get("allowed_roles") or rule.get("allowed_users") or rule.get("user_field"))


def moving_way(rule, doctype, field, old, new):
	"""The move goes the rule's Direction (any, when it has none) in the board's column order."""
	if not rule.get("direction"):
		return True
	order = stage_order(doctype, field)
	if cstr(old) not in order or cstr(new) not in order:
		return False
	forward = order.index(cstr(new)) > order.index(cstr(old))
	return forward if rule.direction == "Forward" else not forward


def may_move(rule, doc, user, roles):
	if user in (rule.get("allowed_users") or []) or roles & set(rule.get("allowed_roles") or []):
		return True
	return bool(rule.get("user_field")) and cstr(doc.get(rule.user_field)) == user


def who_refuses(doc, field, old, new, user=None):
	"""The first rule that holds this user from moving `doc`'s `field` from `old` to `new`, or None."""
	user = user or frappe.session.user
	if user == "Administrator" or cstr(old) == cstr(new):
		return None
	rules = [r for r in get_rules(doc.doctype) if r.stage_field == field and holds_who(r)]
	if not rules:
		return None
	roles = set(frappe.get_roles(user))
	for rule in applicable_rules(rules, field, old, new):
		if old in (None, "") and not cint(rule.get("apply_on_create")):
			continue
		if not moving_way(rule, doc.doctype, field, old, new):
			continue
		if not may_move(rule, doc, user, roles):
			return rule
	return None


def refusal(doc, field, old, new, rule):
	"""(message, title) for a move the rule holds."""
	if rule.get("refusal_message"):
		return _(rule.refusal_message), _("Not allowed")
	who = [frappe.bold(_(r)) for r in rule.allowed_roles] + [frappe.bold(frappe.utils.get_fullname(u)) for u in rule.allowed_users]
	if rule.get("user_field"):
		label = _("Created By") if rule.user_field == "owner" else _(doc.meta.get_label(rule.user_field))
		who.append(_("the document's {0}").format(frappe.bold(label)))
	return (
		_("You can't move {0} from {1} to {2}. Who can: {3}.").format(
			frappe.bold(doc.get_title() or doc.name),
			frappe.bold(_(cstr(old)) or _("nothing")),
			frappe.bold(_(cstr(new))),
			_(", ").join(who) or _("no one"),
		),
		_("Not allowed"),
	)


def before_validate(doc, method=None):
	"""doc_events "*" before_validate: the user may make the move (before the document's own
	validation can move its stage on)."""
	if (
		frappe.flags.in_install
		or frappe.flags.in_migrate
		or frappe.flags.in_patch
		or frappe.flags.ignore_transition_rules
		or doc.flags.ignore_transition_rules
		or doc.flags.ignore_permissions  # code saving for the system, not the user
	):
		return
	rules = get_rules(doc.doctype)
	if not rules:
		return
	before = doc.get_doc_before_save()
	for field in {r.stage_field for r in rules if holds_who(r)}:
		old, new = (before.get(field) if before else None), doc.get(field)
		rule = who_refuses(doc, field, old, new)
		if rule:
			message, title = refusal(doc, field, old, new, rule)
			frappe.throw(message, MoveNotAllowed, title=title)


# ---------- the save check ----------


def validate(doc, method=None):
	"""doc_events "*" validate: block a move that lacks the rule's fields or conditions."""
	if (
		frappe.flags.in_install
		or frappe.flags.in_migrate
		or frappe.flags.in_patch
		or frappe.flags.ignore_transition_rules
		or doc.flags.ignore_transition_rules
		or doc.flags.nx_skip_required  # check_move's early dry run: the popup asks for the fields
	):
		return
	rules = get_rules(doc.doctype)
	if get_settings(doc.doctype):
		# Frappe checks Mandatory Depends On only in the browser; for a DocType on the board it
		# holds on every save too (Kanban, List, API), so a field setting is a real requirement
		data = frappe._dict(doc.as_dict())
		missing = [f for f in mandatory_missing(doc, data, doc.meta) if doc.meta.get_field(f).mandatory_depends_on]
		if missing:
			labels = ", ".join(frappe.bold(_(doc.meta.get_label(f))) for f in missing)
			_moved = [f for f in (get_stage_fields(doc.doctype) or {}).get("stage_fields") or [] if doc.has_value_changed(f)]
			_marker = ""
			if _moved and not doc.is_new():
				_marker = " [[nx-move:" + "|".join(cstr(x) for x in (doc.doctype, doc.name, _moved[0], doc.get(_moved[0]))) + "]]"
			frappe.throw(_("Fill {0} first.").format(labels) + _marker, TransitionRuleError, title=_("Missing fields"))
	if not rules:
		return
	before = doc.get_doc_before_save()
	data = None
	for field in {r.stage_field for r in rules}:
		active = applicable_rules(rules, field, before.get(field) if before else None, doc.get(field))
		if not active:
			continue
		data = data or frappe._dict(doc.as_dict())
		missing = missing_fields(doc, active, data, doc.meta)
		if missing:
			stage = _(cstr(doc.get(field)))
			labels = ", ".join(frappe.bold(_(doc.meta.get_label(f))) for f in missing)
			message = next((r.message for r in active if r.message and r.fields), "")
			frappe.throw(
				(f"{_(message)}<br><br>" if message else "")
				+ _("Fill {0} before moving to {1}.").format(labels, frappe.bold(stage)),
				TransitionRuleError,
				title=_("Required for {0}").format(stage),
			)
		failed = failed_conditions(active, data)
		if failed:
			message, title = condition_message(doc, field, failed[0])
			frappe.throw(message, TransitionRuleError, title=title)


# ---------- what the desk asks ----------


@frappe.whitelist()
def get_stage_fields(doctype: str):
	"""What the desk turns on for a DocType: the fields that have rules, the fields their
	conditions read (so the form can re-check), the move check and the Flow."""
	if not frappe.has_permission(doctype, "read"):
		return {}
	rules = get_rules(doctype)
	settings = get_settings(doctype)
	watch = set()
	for rule in rules:
		for f in rule.fields:
			watch.update(re.findall(r"\bdoc\.(\w+)", f.condition))
			watch.update(re.findall(r"""\bdoc\.get\(\s*["'](\w+)["']""", f.condition))
	return {
		"stage_fields": sorted({r.stage_field for r in rules}),
		"watch": sorted(watch - {"get"}),
		"check_moves": bool(rules) or bool(settings.get("check_moves")),
		"flow": bool(rules) or bool(settings.get("flow_method")),
	}


@frappe.whitelist()
def confirm_view(doctype: str, name: str, field: str, to: str):
	"""The screen a rule asks for before this move: {title, html, label}, or None."""
	doc = frappe.get_doc(doctype, name)
	doc.check_permission("read")
	for rule in applicable_rules([r for r in get_rules(doctype) if r.stage_field == field], field, doc.get(field), to):
		if not rule.get("confirm_view"):
			continue
		out = call_method(rule.confirm_view, doctype=doctype, name=name, to=to) or {}
		if isinstance(out, str):
			out = {"html": out}
		return {
			"title": out.get("title") or _("Move to {0}").format(_(to)),
			"html": out.get("html") or "",
			"label": _(rule.get("confirm_label") or out.get("label") or "Confirm"),
		}
	return None


def _js_to_python(expr):
	"""`mandatory_depends_on` is written for the browser; most of it reads as Python too."""
	expr = expr.replace("===", "==").replace("!==", "!=").replace("&&", " and ").replace("||", " or ")
	# ["A", "B"].includes(doc.x) -> (doc.x in ["A", "B"])
	expr = re.sub(r"(\[[^\[\]]*\])\.includes\(([^()]+)\)", r"(\2 in \1)", expr)
	expr = re.sub(r"!(?!=)", " not ", expr)
	return re.sub(r"\btrue\b", "True", re.sub(r"\bfalse\b", "False", expr))


def depends_on_met(expr, data):
	expr = (expr or "").strip()
	if not expr:
		return False
	if expr.startswith("eval:"):
		try:
			return bool(frappe.safe_eval(_js_to_python(expr[5:]), None, {"doc": _view(data)}))
		except Exception:
			return False
	return not is_empty(data.get(expr))


def mandatory_missing(doc, data, meta):
	"""Fields the form would ask for after the move: Mandatory, and Mandatory Depends On
	(Frappe checks the second only in the browser, so a drag would skip it)."""
	out = [f for f, _msg in doc._get_missing_mandatory_fields() if meta.get_field(f)]
	for df in meta.fields:
		if df.mandatory_depends_on and df.fieldname not in out and is_empty(doc.get(df.fieldname), df):
			if depends_on_met(df.mandatory_depends_on, data):
				out.append(df.fieldname)
	return out


def fetched_values(doc, meta, field, value):
	"""The fields fetched from `field` (Fetch From "field.x") as the save will set them once
	`field` is `value`: a condition that reads one (the stage's type or order, say) sees the
	stage the move goes to, not the one the document is leaving."""
	df = meta.get_field(field)
	if not df or df.fieldtype != "Link" or not df.options:
		return {}
	fetched = [
		f
		for f in meta.fields
		if f.fetch_from
		and f.fetch_from.count(".") == 1
		and f.fetch_from.split(".")[0] == field
		and not (f.fetch_if_empty and not is_empty(doc.get(f.fieldname), f))
	]
	if not fetched:
		return {}
	sources = sorted({f.fetch_from.split(".")[1] for f in fetched})
	try:
		row = (frappe.db.get_value(df.options, value, sources, as_dict=True) if value else None) or {}
	except Exception:
		# a Fetch From the linked DocType can't answer: the save will say so
		return {}
	return {f.fieldname: row.get(f.fetch_from.split(".")[1]) for f in fetched}


def _dry_run(doc, skip_required=False):
	"""Run every validation a save would run, without saving. Returns None or {message, title}.
	Stops before the database write, so on_update / after-save code (emails, jobs) never runs.
	With `skip_required`, empty required fields and the board's own rules don't count: what's
	left is what the popup can't fix (an app's checks), so it shows before any field is asked."""
	log_size = len(frappe.local.message_log)
	frappe.db.savepoint("nx_dry_run")
	doc.flags.nx_dry_run = True
	if skip_required:
		doc.flags.ignore_mandatory = True
		doc.flags.nx_skip_required = True
	try:
		doc.check_if_locked()
		doc._set_defaults()
		if hasattr(doc, "_restore_masked_fields_from_db"):
			doc._restore_masked_fields_from_db()
		doc.check_permission("write", "save")
		doc.set_user_and_timestamp()
		doc.set_docstatus()
		doc.check_if_latest()
		doc.set_parent_in_children()
		doc.set_name_in_children()
		doc.validate_higher_perm_levels()
		doc._validate_links()
		doc.run_before_save_methods()
		doc._validate()
		return None
	except Exception as e:
		entries = [frappe.parse_json(m) if isinstance(m, str) else m for m in frappe.local.message_log[log_size:]]
		last = next((m for m in reversed(entries) if isinstance(m, dict) and m.get("message")), {})
		return {
			"message": last.get("message") or cstr(e) or _("This document cannot be saved."),
			"title": last.get("title") or _("Cannot move"),
		}
	finally:
		frappe.db.rollback(save_point="nx_dry_run")
		del frappe.local.message_log[log_size:]
		doc.flags.nx_dry_run = False
		doc.flags.ignore_mandatory = False
		doc.flags.nx_skip_required = False


@frappe.whitelist()
def check_move(doctype: str, names, field: str, to: str, values=None, dry_run: int = 0):
	"""For the Kanban and List popup: which fields each document needs before `field` can be `to`.
	`values` are what the user typed so far; conditions see them, so dependent fields appear.
	With `dry_run`, a document that needs nothing is validated as if saved; its error comes
	back in `errors` with any action buttons it carries."""
	names = frappe.parse_json(names) or []
	values = frappe.parse_json(values) or {}
	meta = frappe.get_meta(doctype)
	rules = [r for r in get_rules(doctype) if r.stage_field == field]
	docs, titles, errors, candidates = {}, {}, {}, []
	open_form = False
	for name in names:
		doc = frappe.get_doc(doctype, name)
		doc.check_permission("read")
		titles[name] = doc.get_title()
		old = doc.get(field)
		# who may move comes first: no field the popup could ask for changes it
		holder = who_refuses(doc, field, old, to)
		if holder:
			message, title = refusal(doc, field, old, to, holder)
			errors[name] = {"message": message, "title": title, "rule": holder.name}
			docs[name] = []
			continue
		active = applicable_rules(rules, field, old, to)
		open_form = open_form or any(cint(r.get("open_form")) for r in active)

		data = frappe._dict(doc.as_dict())
		for key, value in values.items():
			if meta.get_field(key) and is_empty(data.get(key), meta.get_field(key)):
				data[key] = value
		data[field] = to
		fetched = fetched_values(doc, meta, field, to)
		data.update(fetched)
		need = missing_fields(doc, active, data, meta)
		for f in need:
			if f not in candidates:
				candidates.append(f)

		# from here `doc` is the document after the move, typed values included
		typed = {k: data[k] for k in values if meta.get_field(k) and is_empty(doc.get(k), meta.get_field(k))}
		doc.update(typed)
		doc.set(field, to)
		doc.update(fetched)
		for f in mandatory_missing(doc, data, meta):
			if f not in need:
				need.append(f)
				if f not in candidates:
					candidates.append(f)
		docs[name] = need
		if not cint(dry_run) or cstr(old) == cstr(to) or values:
			continue
		# a Condition that reads none of the fields still to fill can't change in the popup
		failed = [r for r in failed_conditions(active, data) if not any(f in r.condition for f in need)]
		if failed:
			message, title = condition_message(doc, field, failed[0])
			errors[name] = {"message": message, "title": title, "rule": failed[0].name}
			continue
		# with fields still to fill, the save is tried without them first: a block the
		# fields can't lift (another app's check) shows now, not after they're filled
		error = _dry_run(doc, skip_required=bool(need))
		if error:
			errors[name] = error
	related = _related_fields(meta, candidates) if len(names) == 1 else []
	return {
		"open_form": open_form,
		"docs": docs,
		"titles": titles,
		"errors": errors,
		"candidates": candidates,
		"related": related,
		"blocked_move": get_settings(doctype).get("blocked_move") or "Flow",
		"fields": {f: _field_info(meta, f) for f in candidates + related},
	}


NO_POPUP = {"Table", "Table MultiSelect", "Section Break", "Column Break", "Tab Break", "HTML", "Button",
            "Fold", "Heading", "Image", "Read Only", "Dynamic Link"}


def _related_fields(meta, candidates):
	"""Fields that appear or become required with the popup's fields (their Depends On or
	Mandatory Depends On reads one of them): they go in the popup too, hidden until they apply."""
	if not candidates:
		return []
	pattern = re.compile(r"\b(" + "|".join(re.escape(c) for c in candidates) + r")\b")
	out = []
	for df in meta.fields:
		if df.fieldname in candidates or df.fieldtype in NO_POPUP or df.fetch_from or df.hidden:
			continue
		if df.read_only and not df.read_only_depends_on:
			continue
		if pattern.search(" ".join([cstr(df.depends_on), cstr(df.mandatory_depends_on)])):
			out.append(df.fieldname)
	return out[:12]



def _field_info(meta, fieldname):
	df = meta.get_field(fieldname)
	if not df:
		return {"fieldname": fieldname, "label": fieldname, "fieldtype": "Data"}
	return {
		"fieldname": df.fieldname,
		"label": _(df.label),
		"fieldtype": df.fieldtype,
		"options": df.options,
		"description": _(df.description) if df.description else None,
		"read_only": cint(df.read_only),
		"fetch_from": df.fetch_from,
		"depends_on": df.depends_on,
		"mandatory_depends_on": df.mandatory_depends_on,
		"read_only_depends_on": df.read_only_depends_on,
	}


@frappe.whitelist(methods=["POST"])
def move(doctype: str, names, field: str, to: str, values=None):
	"""Move documents to `to`, each saved once together with its popup values.
	One document: errors are raised. Several: failures are returned with their reason."""
	names = frappe.parse_json(names) or []
	values = frappe.parse_json(values) or {}
	meta = frappe.get_meta(doctype)
	if not meta.get_field(field):
		frappe.throw(_("{0} has no field {1}").format(_(doctype), field))
	saved, failed = {}, []
	for name in names:
		extra = {k: v for k, v in (values.get(name) or {}).items() if meta.get_field(k)}
		log_size = len(frappe.local.message_log)
		frappe.db.savepoint("nx_move")
		try:
			doc = frappe.get_doc(doctype, name)
			doc.update(extra)
			doc.set(field, to)
			doc.save()
			saved[name] = doc.get(field)
		except Exception as e:
			if len(names) == 1:
				raise
			frappe.db.rollback(save_point="nx_move")
			del frappe.local.message_log[log_size:]
			failed.append({"name": name, "error": strip_html(cstr(e)).strip() or _("Could not save")})
	return {"saved": saved, "failed": failed}


@frappe.whitelist()
def required_in_form(doc):
	"""For the open form: fields the rules require now, given the move from the saved stage."""
	data = frappe._dict(frappe.parse_json(doc) or {})
	doctype = data.get("doctype")
	if not doctype or not frappe.has_permission(doctype, "read"):
		return []
	rules = get_rules(doctype)
	if not rules:
		return []
	stage_fields = list({r.stage_field for r in rules})
	saved = {}
	if data.get("name") and not data.get("__islocal"):
		if not frappe.has_permission(doctype, "read", data.name):
			return []
		saved = frappe.db.get_value(doctype, data.name, stage_fields, as_dict=True) or {}
	out = []
	for field in stage_fields:
		for rule in applicable_rules(rules, field, saved.get(field), data.get(field)):
			for f in rule.fields:
				if f.fieldname not in out and condition_met(f.condition, data):
					out.append(f.fieldname)
	return out


# ---------- the flow: every stage and what each one needs ----------


def stage_order(doctype, field, board=None):
	"""Stages in board order: the Kanban board's active columns, else the Select options."""
	if not board:
		board = frappe.db.get_value("Kanban Board", {"reference_doctype": doctype, "field_name": field}, "name")
	if board and frappe.db.exists("Kanban Board", board):
		cols = frappe.get_all(
			"Kanban Board Column",
			filters={"parent": board, "parenttype": "Kanban Board"},
			fields=["column_name", "status"],
			order_by="idx asc",
		)
		names = [c.column_name for c in cols if c.status != "Archived" and c.column_name]
		if names:
			return names
	df = frappe.get_meta(doctype).get_field(field)
	if df and df.fieldtype == "Select":
		return [o.strip() for o in (df.options or "").split("\n") if o.strip()]
	return []


def _steps(doc, rules, data, meta):
	out = []
	for rule in rules:
		# who may move is not a step the document takes
		if not rule.fields and not rule.condition and not rule.get("confirm_view"):
			continue
		done = True
		label = rule.get("step_label") or strip_html(_(rule.message or "")).strip()
		if rule.fields:
			missing = missing_fields(doc, [rule], data, meta)
			done = not missing
			if not label:
				names = missing or [f.fieldname for f in rule.fields]
				label = _("Fill {0}").format(", ".join(_(meta.get_label(f)) for f in names))
		if rule.condition and done:
			try:
				done = evaluate(rule.condition, data)
			except Exception:
				done = False
		action = rule.get("action") or ("form" if rule.fields else "")
		out.append(
			{
				"rule": rule.name,
				"label": label or rule.name,
				"done": bool(done),
				"action": action,
				"action_label": _(rule.get("action_label") or ("Fill in" if rule.fields else "Open")),
				"waiting_on": _(rule.get("waiting_on")) if rule.get("waiting_on") else None,
			}
		)
	return out


def _provider_steps(doctype, name):
	"""Steps from the DocType's Flow Steps Method: {field, stages, steps} or {}."""
	method = get_settings(doctype).get("flow_method")
	if not method:
		return {}
	try:
		out = call_method(method, doctype=doctype, name=name) or {}
	except Exception:
		frappe.log_error(title=f"Nexlify Board: Flow Steps Method {method} failed")
		return {}
	if isinstance(out, list):
		out = {"steps": out}
	return out if isinstance(out, dict) else {}


def _clean_step(step):
	return {
		"rule": None,
		"label": _(cstr(step.get("label"))),
		"done": bool(step.get("done")),
		"action": cstr(step.get("action")),
		"action_label": _(step.get("action_label") or "Open"),
		"waiting_on": _(step.get("waiting_on")) if step.get("waiting_on") else None,
	}


@frappe.whitelist()
def get_flow(doctype: str, name: str, field: str | None = None, to: str | None = None, board: str | None = None):
	"""The whole path of a document: every stage in order, and for each stage ahead the steps
	its rules (and its Flow Steps Method) ask for, done or not. `to` marks the stage a blocked
	move was heading to."""
	doc = frappe.get_doc(doctype, name)
	doc.check_permission("read")
	rules = get_rules(doctype)
	provided = _provider_steps(doctype, name)
	if board and not field:
		field = frappe.db.get_value("Kanban Board", board, "field_name")
	if not field:
		fields = sorted({r.stage_field for r in rules})
		field = fields[0] if fields else provided.get("field")
	if not field:
		return {}
	rules = [r for r in rules if r.stage_field == field]
	meta = frappe.get_meta(doctype)
	current = cstr(doc.get(field))
	order = stage_order(doctype, field, board) or list(provided.get("stages") or [])
	if current and current not in order:
		order.insert(0, current)
	here = order.index(current) if current in order else -1
	target = to if to and to != current else None

	stages = []
	for i, stage in enumerate(order):
		item = {"name": stage, "label": _(stage), "steps": []}
		if stage == current:
			item["state"] = "current"
		elif i < here and stage != target:
			item["state"] = "done"
		else:
			item["state"] = "target" if stage == target else "ahead"
			data = frappe._dict(doc.as_dict())
			data[field] = stage
			data.update(fetched_values(doc, meta, field, stage))
			# rules on leaving the current stage (To empty) belong to the move being made
			active = [
				r
				for r in applicable_rules(rules, field, current, stage)
				if r.to_value or stage == (target or _next(order, here))
			]
			item["steps"] = _steps(doc, active, data, meta)
		item["steps"] += [_clean_step(x) for x in provided.get("steps") or [] if cstr(x.get("stage")) == stage]
		stages.append(item)
	# a move over several stages needs what each of them needs: their steps count for the target
	if target and target in order and here >= 0:
		ti = order.index(target)
		passed = []
		for item in stages[here + 1:ti]:
			passed += item["steps"]
			item["steps"] = []
		stages[ti]["steps"] = passed + stages[ti]["steps"]
	return {"field": field, "current": current, "target": target, "title": doc.get_title(), "stages": stages}


def _next(order, here):
	return order[here + 1] if 0 <= here < len(order) - 1 else None
