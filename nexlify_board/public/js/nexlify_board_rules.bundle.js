// Nexlify Board in the desk: Transition Rules, the move check, the Flow and Confirm Views.
// The server checks every save (nexlify_board.transition_rules.validate); the desk asks for
// the missing fields first: the form marks them required, and a Kanban drag or a List bulk
// edit opens a popup with only the fields that move still needs.
//
// A Kanban drag on a DocType with rules, or one listed in Nexlify Board Settings, is checked
// like a save before the card moves. A move that passed sets `move.validated = true`, so
// another app's own before-move check can skip itself and only add its screens.
const API = "nexlify_board.transition_rules.";
const BULK = "frappe.desk.doctype.bulk_update.bulk_update.submit_cancel_or_update_docs";
const FORM_ONLY = new Set(["Table", "Dynamic Link"]); // Table MultiSelect (Lost Reasons…) fits in the popup
const infos = {}; // doctype -> { at, promise }, refreshed after a minute
const board_fields = {};
const pending = new Map(); // "doctype::name" -> { to, values }, read by the Kanban provider
const decisions = new WeakMap(); // move.cardIds -> one decision per drag
const known = {}; // doctype -> has a Flow (sync, for the card menu)

// A read the open form doesn't wait for. A frappe.call is one of Frappe's pending calls, and a form
// script after a handler that returns nothing waits for all of them (frappe.after_server_call): on a
// slow network the form's own buttons showed late, and the ones it takes off showed meanwhile.
async function background_read(method, args) {
	const r = await fetch(`/api/method/${method}`, {
		method: "POST",
		headers: {
			Accept: "application/json",
			"Content-Type": "application/json",
			"X-Frappe-CSRF-Token": frappe.csrf_token,
		},
		body: JSON.stringify(args),
	});
	if (!r.ok) throw new Error(`${method}: ${r.status}`);
	return (await r.json()).message;
}

function stage_info(doctype) {
	const hit = infos[doctype];
	if (!hit || Date.now() - hit.at > 60000) {
		const promise = background_read(API + "get_stage_fields", { doctype }).catch(() => ({}));
		infos[doctype] = { at: Date.now(), promise };
	}
	return infos[doctype].promise;
}

async function has_rules(doctype, field) {
	return ((await stage_info(doctype)).stage_fields || []).includes(field);
}

// ---------- the DocType's Client Scripts, run on the popup ----------
//
// The popup is a piece of the form: the DocType's Client Scripts (Form view) run on it, so what
// they do on a field in the form (show or hide fields, make them required, filter a Link, fill
// one field from another, stop a save in `validate`) happens in the popup too. They run against
// a stand-in `frm` whose doc is the document after the move; calls that only make sense on the
// full form (buttons, dashboard, sidebar...) do nothing here.
const script_handlers = {}; // doctype -> { event: [handler] }

// Nexlify Board: popup runs the DocType's own JS (standard + Client Scripts), like the form
const NX_SINK = new Proxy(function () {}, { get: (_, p) => (p === "then" ? undefined : NX_SINK), apply: () => NX_SINK });
const NX_SCRIPT_CACHE = {};

async function client_script_handlers(doctype) {
	if (NX_SCRIPT_CACHE[doctype]) return NX_SCRIPT_CACHE[doctype];
	await frappe.model.with_doctype(doctype);
	const meta = frappe.get_meta(doctype) || {};
	const handlers = {};
	const cscript = {};
	const late = new Proxy({}, {
		get: (_, p) => {
			if (p === "cscript") return cscript;
			if (p === "doctype") return doctype;
			const a = handlers.__active;
			return a ? a[p] : typeof p === "symbol" ? undefined : NX_SINK;
		},
		set: (_, p, v) => {
			if (handlers.__active) handlers.__active[p] = v;
			return true;
		},
	});
	const collect = (dt, ev, fn) => {
		if (dt !== doctype) return;
		const add = (k, f) => typeof f === "function" && (handlers[k] = handlers[k] || []).push(f);
		!fn && $.isPlainObject(ev) ? Object.entries(ev).forEach(([k, f]) => add(k, f)) : add(ev, fn);
	};
	const { on, on_change } = frappe.ui.form;
	const prev_cur = window.cur_frm;
	frappe.ui.form.on = frappe.ui.form.on_change = collect;
	try {
		for (const [code, what] of [[meta.__js, "DocType script"], [meta.__custom_js, "Client Script"]]) {
			if (!code) continue;
			window.cur_frm = late;
			try {
				new Function(code)();
			} catch (e) {
				console.warn(`Nexlify Board: the ${what} of ${doctype} did not fully load in the popup`, e);
			}
		}
	} finally {
		frappe.ui.form.on = on;
		frappe.ui.form.on_change = on_change;
		window.cur_frm = prev_cur;
	}
	handlers.__cscript = cscript;
	return (NX_SCRIPT_CACHE[doctype] = handlers);
}

// anything not on the stand-in: callable, chainable, and does nothing
const sink = new Proxy(function () {}, { get: (t, k) => (k === "then" ? undefined : sink), apply: () => sink });

function popup_form(doctype, name, doc, dialog, handlers) {
	handlers = handlers || {};
	const outside = {};
	const has = (f) => !!dialog.fields_dict[f];
	const each = (f, fn) => [].concat(f || []).forEach((x) => has(x) && fn(x));
	const base = {
		doctype,
		docname: name,
		doc,
		meta: frappe.get_meta(doctype),
		fields_dict: dialog.fields_dict,
		events: {},
		cscript: handlers.__cscript || {},
		perm: [{ read: 1, write: 1 }],
		is_new: () => false,
		is_dirty: () => true,
		get_field: (f) => dialog.fields_dict[f],
		get_doc: () => doc,
		set_value(f, v) {
			if (f && typeof f === "object") return Promise.all(Object.entries(f).map(([k, x]) => frm.set_value(k, x)));
			doc[f] = v;
			if (has(f)) return dialog.set_value(f, v);
			outside[f] = v;
			return Promise.resolve();
		},
		set_df_property: (f, p, v) => has(f) && dialog.set_df_property(f, p, v),
		toggle_reqd: (f, on) => each(f, (x) => dialog.set_df_property(x, "reqd", on ? 1 : 0)),
		toggle_display: (f, on) => each(f, (x) => dialog.set_df_property(x, "hidden", on ? 0 : 1)),
		toggle_enable: (f, on) => each(f, (x) => dialog.set_df_property(x, "read_only", on ? 0 : 1)),
		set_query(f, a, b) {
			const table = typeof a === "string" ? a : null;
			const q = table ? b : a;
			if (!q) return;
			const getter = typeof q === "function" ? (d) => q(d || doc) : () => q;
			if (table) {
				const g = dialog.fields_dict[table] && dialog.fields_dict[table].grid;
				const df = g && g.get_field && g.get_field(f);
				if (df) df.get_query = getter;
				return;
			}
			if (has(f)) dialog.fields_dict[f].get_query = () => getter(doc);
		},
		add_fetch: () => {},
		refresh_field: (f) => each(f, (x) => dialog.fields_dict[x].refresh()),
		refresh_fields: () => dialog.refresh(),
		trigger: (e) => run(e),
		call: (m, args) => frappe.call(typeof m === "string" ? { method: m, args } : m),
		save: () => Promise.resolve(),
		reload_doc: () => Promise.resolve(),
	};
	const frm = new Proxy(base, { get: (t, p) => (p in t ? t[p] : typeof p === "symbol" ? undefined : NX_SINK) });
	const soft = (e) => e instanceof TypeError || e instanceof ReferenceError;
	async function run(event, strict = false) {
		handlers.__active = frm;
		for (const fn of handlers[event] || []) {
			try {
				await fn(frm, doctype, name);
			} catch (e) {
				if (strict && !soft(e)) throw e;
				console.error(`Nexlify Board: "${event}" on ${doctype}`, e);
			}
		}
		const cs = handlers.__cscript;
		if (cs && typeof cs[event] === "function") {
			try {
				await cs[event](doc, doctype, name);
			} catch (e) {
				if (strict && !soft(e)) throw e;
				console.error(`Nexlify Board: controller "${event}" on ${doctype}`, e);
			}
		}
	}
	return { frm, run, outside };
}

// ---------- the look of the board's popups ----------
//
// One skin for every popup the board opens (move, fields, Flow, Confirm View): plain and tidy,
// an accent line, an eyebrow over the title, the move as chips, fields two by two.
// Built on Frappe's CSS variables, so it follows the theme (light and dark).
const SKIN_CSS = `
.modal.nx-dlg{--nx-accent:#4f46e5;--nx-accent-2:#7c3aed;--nx-accent-3:#0ea5e9;--nx-soft:rgba(79,70,229,.10);--nx-ring:rgba(79,70,229,.28)}
[data-theme="dark"] .modal.nx-dlg{--nx-accent:#818cf8;--nx-accent-2:#a78bfa;--nx-accent-3:#38bdf8;--nx-soft:rgba(129,140,248,.14);--nx-ring:rgba(129,140,248,.35)}
.modal.nx-dlg .modal-content{border:none;border-radius:20px;
  box-shadow:0 16px 40px -12px rgba(15,23,42,.28),0 0 0 1px var(--border-color)}
.modal.nx-dlg .modal-header{position:relative;padding:24px 28px 18px;border-radius:20px 20px 0 0;overflow:hidden;border-bottom:1px solid var(--border-color);
  background:var(--modal-bg,var(--card-bg))}
.modal.nx-dlg .modal-header::before{content:"";position:absolute;left:0;right:0;top:0;height:3px;
  background:var(--nx-accent)}
.modal.nx-dlg .modal-header .title-section{flex-direction:column;align-items:flex-start;gap:0}
.modal.nx-dlg .modal-header .modal-title{margin:0;font-size:21px;font-weight:700;letter-spacing:-.02em;line-height:1.3;color:var(--heading-color,var(--text-color))}
.modal.nx-dlg .nx-eyebrow{display:inline-flex;align-items:center;gap:8px;font-size:11px;font-weight:700;text-transform:uppercase;
  letter-spacing:.1em;color:var(--nx-accent);margin-bottom:8px}
.modal.nx-dlg .nx-sub{margin-top:6px;font-size:13px;color:var(--text-muted)}
.modal.nx-dlg .nx-route{display:flex;align-items:center;gap:8px;margin-top:14px;flex-wrap:wrap}
.modal.nx-dlg .nx-chip{display:inline-flex;align-items:center;padding:5px 14px;border-radius:999px;font-size:12px;font-weight:600;
  background:var(--subtle-fg);color:var(--text-muted);border:1px solid var(--border-color)}
.modal.nx-dlg .nx-chip.nx-to{background:var(--nx-soft);color:var(--nx-accent);border-color:var(--nx-ring)}
.modal.nx-dlg .nx-arrow{color:var(--text-light);font-size:16px}
.modal.nx-dlg .modal-body{padding:24px 28px;background:var(--modal-bg,var(--card-bg));position:relative;z-index:2}
.modal.nx-dlg .awesomplete>ul{z-index:1060}
.modal.nx-dlg .nx-fields{display:flex!important;flex-wrap:wrap;gap:4px 24px}
.modal.nx-dlg .nx-fields>.nx-half{flex:1 1 calc(50% - 12px);min-width:240px;max-width:100%}
.modal.nx-dlg .nx-fields>.nx-wide{flex:1 1 100%}
.modal.nx-dlg .control-label{display:block;font-size:12px;font-weight:600;color:var(--text-muted);margin-bottom:6px}
.modal.nx-dlg .form-control,.modal.nx-dlg .input-with-feedback{border-radius:10px;min-height:40px;
  border:1px solid transparent;transition:box-shadow .15s,border-color .15s,background .15s}
.modal.nx-dlg .form-control:focus{border-color:var(--nx-accent);box-shadow:0 0 0 3px var(--nx-ring);background:var(--modal-bg,var(--card-bg))}
.modal.nx-dlg textarea.form-control{min-height:96px}
.modal.nx-dlg .form-grid{border-radius:12px;overflow:hidden;border:1px solid var(--border-color)}
.modal.nx-dlg .form-grid .grid-heading-row{background:var(--subtle-fg);font-weight:600}
.modal.nx-dlg .grid-add-row,.modal.nx-dlg .grid-footer .btn{border-radius:8px}
.modal.nx-dlg .modal-footer{padding:16px 28px;border-radius:0 0 20px 20px;background:var(--subtle-fg);border-top:1px solid var(--border-color)}
.modal.nx-dlg .modal-footer .btn{border-radius:10px;padding:9px 20px;font-weight:600;font-size:13px}
.modal.nx-dlg .modal-footer .btn-primary{border:none;color:#fff;background:var(--nx-accent)}
.modal.nx-dlg .modal-footer .btn-primary:hover{filter:brightness(1.08)}
.modal.nx-dlg .modal-footer .btn-secondary{background:var(--modal-bg,var(--card-bg));border:1px solid var(--border-color)}
.modal.nx-dlg .nx-flow-stage.nx-blue .nx-flow-dot{background:var(--nx-soft);color:var(--nx-accent);box-shadow:0 0 0 2px var(--nx-accent)}
.modal.nx-dlg .nx-flow-stage.nx-blue .nx-flow-name{color:var(--nx-accent)}
.modal.nx-dlg .nx-flow-dot{width:32px;height:32px;font-size:13px}
.modal.nx-dlg .nx-flow-line{margin-top:15px}
.modal.nx-dlg .nx-flow-step{padding:11px 10px;border-radius:10px;border-top:none;margin:2px 0}
.modal.nx-dlg .nx-flow-step.nx-todo{background:color-mix(in srgb,var(--bg-red,#fee2e2) 45%,transparent)}
.modal.nx-dlg .nx-flow-step .btn{border-radius:8px;font-weight:600;background:var(--modal-bg,var(--card-bg));
  border:1px solid var(--border-color)}
.modal.nx-dlg .nx-flow-step .btn:hover{border-color:var(--nx-accent);color:var(--nx-accent)}
.modal.nx-dlg .nx-flow-group{font-weight:700;text-transform:uppercase;letter-spacing:.06em;font-size:11px;margin:18px 0 6px}
.modal.nx-dlg .nx-flow-sub{display:none}
.modal.nx-dlg .nx-flow-mark{flex:0 0 18px}
`;

function skin(d, { eyebrow, sub, from, to } = {}) {
	if (!document.getElementById("nx-dialog-skin")) {
		$(`<style id="nx-dialog-skin">${SKIN_CSS}</style>`).appendTo(document.head);
	}
	const esc = frappe.utils.escape_html;
	d.$wrapper.addClass("nx-dlg");
	// fields two by two, wide ones (tables, long text) across: set on the controls themselves,
	// whatever markup the Frappe version wraps them in
	const WIDE = new Set(["Table", "Table MultiSelect", "Small Text", "Text", "Long Text", "Text Editor", "HTML", "Code", "JSON"]);
	(d.fields_list || []).forEach((f) => {
		const $w = f.$wrapper;
		if (!$w || !$w.length) return;
		$w.parent().addClass("nx-fields");
		$w.addClass(WIDE.has(f.df.fieldtype) ? "nx-wide" : "nx-half");
	});
	const $section = d.$wrapper.find(".modal-header .title-section").first();
	$section.find(".nx-eyebrow,.nx-sub,.nx-route").remove();
	if (eyebrow) $section.prepend(`<div class="nx-eyebrow">${esc(eyebrow)}</div>`);
	if (sub) $section.append(`<div class="nx-sub">${sub}</div>`);
	if (to) {
		$section.append(`<div class="nx-route">
			${from ? `<span class="nx-chip">${esc(__(from))}</span><span class="nx-arrow">→</span>` : ""}
			<span class="nx-chip nx-to">${esc(__(to))}</span></div>`);
	}
	return d;
}

// ---------- an action that edits some fields: "fields:a,b,c" ----------
//
// A step's button (or any data-nx-action) can open a popup with some fields of the document,
// tables included, instead of the whole form: `fields:custom_requirements` or
// `fields:contact_person,expected_closing`. The DocType's Client Scripts run on it as in the
// form, and Save saves the document (its server checks run as usual).
const LAYOUT = new Set(["Section Break", "Column Break", "Tab Break", "HTML", "Button", "Fold", "Heading"]);

async function edit_fields(doctype, name, fieldnames, after) {
	await frappe.model.with_doctype(doctype);
	const meta = frappe.get_meta(doctype);
	const saved = await frappe.db.get_doc(doctype, name);
	const doc = JSON.parse(JSON.stringify(saved));
	const tables = {};
	const fields = [];
	for (const f of fieldnames) {
		const df = meta.fields.find((d) => d.fieldname === f);
		if (!df) continue;
		const field = {
			fieldname: f,
			label: __(df.label),
			fieldtype: df.fieldtype,
			options: df.options,
			description: df.description,
			reqd: df.reqd,
			read_only: df.read_only,
			depends_on: df.depends_on,
			mandatory_depends_on: df.mandatory_depends_on,
			default: doc[f],
		};
		if (df.fieldtype === "Table") {
			await frappe.model.with_doctype(df.options);
			tables[f] = df.options;
			field.fields = frappe
				.get_meta(df.options)
				.fields.filter((c) => !LAYOUT.has(c.fieldtype) && !c.hidden)
				.map((c) => ({
					fieldname: c.fieldname,
					label: __(c.label),
					fieldtype: c.fieldtype,
					options: c.options,
					in_list_view: c.in_list_view,
					columns: c.columns,
					read_only: c.read_only,
					reqd: c.reqd,
				}));
			field.data = (doc[f] || []).map((r) => ({ ...r }));
			field.cannot_add_rows = df.cannot_add_rows;
			delete field.default;
		}
		fields.push(field);
	}
	if (!fields.length) return frappe.set_route("Form", doctype, name);

	const handlers = await client_script_handlers(doctype);
	return new Promise((resolve) => {
		let form = null;
		let done = false;
		const d = new frappe.ui.Dialog({
			title: saved[meta.title_field] || name,
			size: Object.keys(tables).length ? "extra-large" : undefined,
			fields: fields.map((f) =>
				tables[f.fieldname] ? f : { ...f, onchange: () => form && ((doc[f.fieldname] = d.get_value(f.fieldname)), form.run(f.fieldname)) }
			),
			primary_action_label: __("Save"),
			async primary_action(values) {
				frappe.validated = true;
				try {
					await form.run("validate", true);
				} catch (e) {
					return;
				}
				if (frappe.validated === false) return;
				const out = { ...saved, ...form.outside };
				for (const f of fields) {
					if (!tables[f.fieldname]) {
						out[f.fieldname] = values[f.fieldname];
						continue;
					}
					// rows keep their name, and what the popup didn't show
					const before = Object.fromEntries((saved[f.fieldname] || []).map((r) => [r.name, r]));
					out[f.fieldname] = (values[f.fieldname] || []).map((r, i) => {
						const row = { ...(before[r.name] || {}), ...r, idx: i + 1 };
						if (!before[r.name]) delete row.name;
						return { ...row, doctype: tables[f.fieldname], parentfield: f.fieldname, parenttype: doctype, parent: name };
					});
				}
				await frappe.call({ method: "frappe.client.save", args: { doc: out }, freeze: true });
				done = true;
				d.hide();
				frappe.show_alert({ message: __("Saved"), indicator: "green" });
				after && after();
				resolve(true);
			},
		});
		d.onhide = () => !done && resolve(false);
		form = popup_form(doctype, name, doc, d, handlers);
		skin(d, {
			eyebrow: __(doctype),
			sub: fields.map((f) => frappe.utils.escape_html(f.label)).join(" · "),
		});
		d.show();
		form.run("setup").then(() => form.run("onload")).then(() => form.run("refresh"));
	});
}
window.nx_edit_fields = edit_fields;

// ---------- the popup (Kanban + List) ----------

// Asks for what `names` need before `field` becomes `to`. Resolves to
// { name: { fieldname: value } }, "form" (open the full form) or null (cancelled).
// With dry_run, a move that needs no fields is validated as a save; an error cancels it.
async function ask_for_move(doctype, names, field, to, allow_form = true, dry_run = false) {
	let check = await frappe.xcall(API + "check_move", { doctype, names, field, to, dry_run: dry_run ? 1 : 0 });
	check.to = to;
	if (Object.keys(check.errors || {}).length) {
		show_errors(doctype, check);
		return null;
	}
	if (check.open_form) {
		if (names.length === 1 && allow_form) return "form";
		frappe.msgprint(__("Moving to {0} opens the form. Move these one at a time.", [__(to)]));
		return null;
	}
	const needed = () => new Set(Object.values(check.docs || {}).flat());
	if (!needed().size) return {};

	const single = names.length === 1;
	// read-only fields are set by the server too (ERPNext's Lost Reasons are read-only);
	// only a fetched field has to come from the form
	const form_only = (f) => FORM_ONLY.has(check.fields[f].fieldtype) || check.fields[f].fetch_from;
	if (check.candidates.some(form_only)) {
		if (single && allow_form) return "form";
		frappe.msgprint(__("Some required fields can only be filled in the form. Move these one at a time."));
		return null;
	}
	// a Table MultiSelect in a dialog needs its child DocType loaded
	await Promise.all(
		[...check.candidates, ...(check.possible || [])]
			.filter((f) => check.fields[f].fieldtype === "Table MultiSelect")
			.map((f) => frappe.model.with_doctype(check.fields[f].options))
	);

	// one document: the popup carries the document after the move, and its Client Scripts run on it
	let doc = null;
	let handlers = {};
	let from_stage = null;
	if (single) {
		await frappe.model.with_doc(doctype, names[0]);
		from_stage = frappe.get_doc(doctype, names[0])[field];
		doc = { ...frappe.get_doc(doctype, names[0]), [field]: to };
		handlers = await client_script_handlers(doctype);
	}
	const related = check.related || [];
	// the fields asked now, and those a rule asks once a value is typed (hidden till then); a field only the
	// form can fill isn't among the latter: the save asks for it
	const asked = [
		...check.candidates,
		...(check.possible || []).filter((f) => !check.candidates.includes(f) && !form_only(f)),
	];

	return new Promise((resolve) => {
		let done = false;
		let form = null; // the stand-in frm, made once the dialog exists
		let changed = () => {};
		const finish = (v) => {
			if (done) return;
			done = true;
			resolve(v);
		};
		const show_needed = () => {
			const need = needed();
			for (const f of asked) {
				// a field the rules ask for shows: its own Depends On may read a field the popup hasn't (the
				// form's hidden flags), which would keep it hidden
				const control = dialog.fields_dict[f];
				if (need.has(f) && control) {
					control.df.depends_on = "";
					control.df.hidden_due_to_dependency = false;
				}
				dialog.set_df_property(f, "hidden", need.has(f) ? 0 : 1);
				dialog.set_df_property(f, "reqd", need.has(f) ? 1 : 0);
			}
		};
		// conditions can read what was just typed, so dependent fields appear or hide
		const recheck = async () => {
			const values = dialog.get_values(true) || {};
			const r = await frappe.xcall(API + "check_move", { doctype, names, field, to, values });
			check = { ...check, docs: r.docs };
			show_needed();
			return values;
		};

		const dialog = new frappe.ui.Dialog({
			title: single ? check.titles[names[0]] || names[0] : __("{0} records", [names.length]),
			doc,
			fields: [
				...asked.map((f) => {
					const { label, fieldtype, options, description } = check.fields[f];
					return { fieldname: f, label, fieldtype, options, description, onchange: () => changed(f) };
				}),
				// fields that show or become required with them; their Depends On decide
				...related.map((f) => {
					const i = check.fields[f];
					return {
						fieldname: f,
						label: i.label,
						fieldtype: i.fieldtype,
						options: i.options,
						description: i.description,
						depends_on: i.depends_on,
						mandatory_depends_on: i.mandatory_depends_on,
						read_only_depends_on: i.read_only_depends_on,
						onchange: () => changed(f),
					};
				}),
			],
			primary_action_label: __("Save & Move"),
			async primary_action() {
				const values = await recheck();
				if (!dialog.get_values()) return; // a field that just became required is empty
				if (form) {
					// the form's own checks before a save
					frappe.validated = true;
					try {
						await form.run("validate", true);
					} catch (e) {
						return;
					}
					if (frappe.validated === false) return;
				}
				const out = {};
				for (const name of names) {
					out[name] = Object.fromEntries((check.docs[name] || []).map((f) => [f, values[f]]));
				}
				if (form) {
					// one document: everything typed in the popup, and what its scripts set
					for (const [f, v] of Object.entries(values)) if (v !== undefined) out[names[0]][f] = v;
					Object.assign(out[names[0]], form.outside);
				}
				finish(out);
				dialog.hide();
			},
			secondary_action_label: single && allow_form ? __("Open Form") : null,
			secondary_action:
				single && allow_form
					? () => {
							finish("form");
							dialog.hide();
					  }
					: null,
			onhide: () => finish(null),
		});
		// a field changed: its Client Script events, then the rules again
		form = single ? popup_form(doctype, names[0], doc, dialog, handlers) : null;
		// a dialog made on the document takes its fields' definitions from the DocType, without their
		// onchange: put it back, so what is typed reaches the rules
		for (const f of [...asked, ...related]) {
			const control = dialog.fields_dict[f];
			if (control && !control.df.onchange) control.df.onchange = () => changed(f);
		}
		changed = async (f) => {
			// the form's own event for the field first; failing, the rules still see the value
			if (form) {
				try {
					await form.run(f);
				} catch (e) {
					console.error(e);
				}
			}
			await recheck();
		};
		show_needed();
		skin(dialog, {
			eyebrow: __("Move · {0}", [__(doctype)]),
			sub: __("Fill in what {0} needs; the card moves when you save.", [frappe.utils.escape_html(__(to))]),
			from: single ? from_stage : null,
			to,
		});
		dialog.show();
		if (form) form.run("setup").then(() => form.run("onload")).then(() => form.run("refresh")).then(() => dialog.refresh_dependency());
		if (!single) dialog.set_message(__("Values go only to records where the field is empty."));
	});
}
window.nx_move = ask_for_move;


// a blocked move: the same message the form would show, with its action buttons
function show_errors(doctype, check) {
	const esc = frappe.utils.escape_html;
	const names = Object.keys(check.errors);
	const open_btn = (name) =>
		`<button class="btn btn-xs btn-default nx-action" data-nx-action="form" ` +
		`data-doctype="${esc(doctype)}" data-name="${esc(name)}">${__("Open Form")}</button>`;
	// the Flow, unless the DocType's settings turn it off (Show Flow)
	if (names.length === 1 && check.show_flow) {
		const { message, rule } = check.errors[names[0]];
		// a rule's message is already a step in the flow; anything else is shown above it
		show_flow(doctype, names[0], { to: check.to, error: rule ? null : message });
		return;
	}
	if (names.length === 1) {
		// one document: its message, with one button to open it (the rule's own, or Open Form)
		const { message, title } = check.errors[names[0]];
		const has_action = /data-nx-action=/.test(message || "");
		frappe.msgprint({
			title: title || __("Not moved"),
			indicator: "red",
			message: has_action ? message : `${message}<p style="margin-top:12px">${open_btn(names[0])}</p>`,
		});
		return;
	}
	frappe.msgprint({
		title: __("Not moved"),
		indicator: "red",
		message: names
			.map((n) => `<p><b>${esc(check.titles[n] || n)}</b> ${open_btn(n)}<br>${check.errors[n].message}</p>`)
			.join(""),
	});
}


// ---------- the flow: every stage and what each one needs ----------

const STEP_ICON = { done: "✓", todo: "✕", later: "○" }; // text: no icon set to depend on

async function show_flow(doctype, name, { to = null, error = null } = {}) {
	const route = frappe.get_route();
	const board = route[0] === "List" && route[2] === "Kanban" ? route[3] : null;
	const flow = await frappe.xcall(API + "get_flow", { doctype, name, to, board });
	if (!flow || !flow.stages) {
		// no rules or steps for this DocType: the plain message, with its buttons
		if (error) frappe.msgprint({ title: __("Cannot move"), indicator: "red", message: error });
		return;
	}
	const esc = frappe.utils.escape_html;
	const focus = flow.stages.find((s) => s.state === "target") || flow.stages.find((s) => s.state === "ahead");
	const blocked = focus && focus.steps.some((s) => !s.done);
	if (blocked) error = null; // the steps already say what's missing
	const title = flow.target
		? blocked || error
			? __("Can't move to {0} yet", [__(flow.target)])
			: __("Ready for {0}", [__(flow.target)])
		: __("Flow");

	const dot = (s, i) => {
		const pending = s.steps.some((x) => !x.done);
		const kind =
			s.state === "done"
				? ["green", "✓"]
				: s.state === "current"
				? ["blue", i + 1]
				: s.state === "target"
				? pending ? ["red", i + 1] : ["green", i + 1]
				: ["gray", i + 1];
		const inner = kind[1];
		const sub = s.state === "current" ? __("now") : s.state === "target" ? __("target") : "";
		return `<div class="nx-flow-stage nx-${kind[0]}">
			<div class="nx-flow-dot">${inner}</div>
			<div class="nx-flow-name">${esc(s.label)}${sub ? `<br><small>${sub}</small>` : ""}</div></div>`;
	};
	const line = (a, b) => {
		const c = b.state === "target" ? (b.steps.some((x) => !x.done) ? "red" : "green") : a.state === "done" || b.state === "current" ? "green" : "gray";
		return `<div class="nx-flow-line nx-${c}"></div>`;
	};
	const stepper = flow.stages.map((s, i) => (i ? line(flow.stages[i - 1], s) : "") + dot(s, i)).join("");

	const btn = (step) =>
		`<button class="btn btn-xs btn-default" data-nx-action="${esc(step.action)}" ` +
		`data-doctype="${esc(doctype)}" data-name="${esc(name)}">${esc(step.action_label)}</button>`;
	const step_row = (step, active, next) => {
		const kind = step.done ? "done" : active ? "todo" : "later";
		let right = "";
		if (!step.done && active) {
			right = step.waiting_on
				? `<span class="nx-flow-wait">${__("Waiting on {0}", [esc(step.waiting_on)])}</span>`
				: step.action
				? btn(step)
				: "";
		}
		return `<div class="nx-flow-step nx-${kind}${next ? " nx-next" : ""}">
			<b class="nx-flow-mark">${STEP_ICON[kind]}</b><span>${esc(step.label)}</span>${right}</div>`;
	};
	const sections = flow.stages
		.filter((s) => (s.state === "target" || s.state === "ahead") && s.steps.length)
		.map((s) => {
			const active = s === focus;
			const first_open = active ? s.steps.findIndex((x) => !x.done) : -1;
			const head = active ? __("Needed for {0}", [esc(s.label)]) : __("Later: {0}", [esc(s.label)]);
			return `<div class="nx-flow-group${active ? "" : " nx-muted"}">${head}</div>` +
				s.steps.map((x, i) => step_row(x, active, i === first_open)).join("");
		})
		.join("");
	const done_n = focus ? focus.steps.filter((s) => s.done).length : 0;
	const sub = focus && focus.steps.length
		? __("{0} of {1} steps done for {2}", [done_n, focus.steps.length, esc(focus.label)])
		: "";

	const d = new frappe.ui.Dialog({
		title,
		size: "large",
		primary_action_label: __("Open Form"),
		primary_action() {
			d.hide();
			frappe.set_route("Form", doctype, name);
		},
	});
	$(d.body).html(`${FLOW_CSS}
		<div class="nx-flow">
			<div class="nx-flow-sub">${esc(flow.title || name)}${sub ? " · " + sub : ""}</div>
			${error ? `<div class="nx-flow-error">${error}</div>` : ""}
			<div class="nx-flow-stepper">${stepper}</div>
			${sections || `<div class="nx-flow-group">${__("No steps are set for the stages ahead.")}</div>`}
		</div>`);
	skin(d, { eyebrow: __("Flow · {0}", [__(doctype)]), sub: `${esc(flow.title || name)}${sub ? " · " + sub : ""}`, from: flow.target ? flow.current : null, to: flow.target });
	d.show();
	return d;
}

const FLOW_CSS = `<style>
.nx-flow-sub{color:var(--text-muted);font-size:var(--text-sm);margin-bottom:12px}
.nx-flow-error{background:var(--bg-red);color:var(--text-on-red, var(--red-700));padding:8px 12px;border-radius:var(--border-radius);margin-bottom:12px}
.nx-flow-stepper{display:flex;align-items:flex-start;margin:4px 0 8px}
.nx-flow-stage{display:flex;flex-direction:column;align-items:center;gap:6px;flex:0 0 auto;width:84px}
.nx-flow-dot{width:28px;height:28px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:600;background:var(--subtle-fg);color:var(--text-muted)}
.nx-flow-name{font-size:12px;text-align:center;color:var(--text-muted);line-height:1.3}
.nx-flow-line{flex:1;height:2px;margin-top:13px;background:var(--border-color)}
.nx-flow-stage.nx-green .nx-flow-dot{background:var(--bg-green);color:var(--text-on-green, var(--green-600))}
.nx-flow-stage.nx-blue .nx-flow-dot{background:var(--bg-blue);color:var(--text-on-blue, var(--blue-600));box-shadow:0 0 0 1.5px var(--blue-500)}
.nx-flow-stage.nx-blue .nx-flow-name{color:var(--blue-600)}
.nx-flow-stage.nx-red .nx-flow-dot{background:var(--bg-red);color:var(--text-on-red, var(--red-600));box-shadow:0 0 0 1.5px var(--red-400)}
.nx-flow-stage.nx-red .nx-flow-name{color:var(--red-600)}
.nx-flow-line.nx-green{background:var(--green-400)}.nx-flow-line.nx-red{background:var(--red-300)}
.nx-flow-group{font-size:12px;color:var(--text-muted);margin:16px 0 4px}
.nx-flow-group.nx-muted{opacity:.75}
.nx-flow-step{display:flex;align-items:center;gap:10px;padding:7px 0;border-top:1px solid var(--border-color)}
.nx-flow-step>span{flex:1}
.nx-flow-mark{width:16px;text-align:center;font-size:14px}
.nx-flow-step.nx-done{color:var(--text-muted)}.nx-flow-step.nx-done .nx-flow-mark{color:var(--green-500)}
.nx-flow-step.nx-todo .nx-flow-mark{color:var(--red-500)}.nx-flow-step.nx-later .nx-flow-mark{color:var(--gray-400)}
.nx-flow-step.nx-later{color:var(--text-muted)}
.nx-flow-step.nx-next>span{font-weight:500}
.nx-flow-wait{font-size:12px;color:var(--orange-600, var(--yellow-700))}
</style>`;

frappe.provide("nexlify.board");
nexlify.board.show_flow = show_flow;

// A stage change started outside the board (a stage bar on a form, say): the same checks,
// popup and confirm screen as dragging the card. Resolves the values to set with the move
// ({ fieldname: value }), "form" when what's missing can only be filled in the form, or null
// when the move is blocked or cancelled. The caller sets the values and saves.
nexlify.board.ask_move = async (doctype, name, field, to) => {
	window.nx_action_context = nexlify.board.context = { doctype, name, names: [name] };
	if (!(await stage_info(doctype)).check_moves) return {};
	const answer = await ask_for_move(doctype, [name], field, to, true, true);
	if (!answer || answer === "form") return answer;
	if (!(await confirm_move(doctype, name, field, to))) return null;
	return answer[name] || {};
};

// "Open Form": the real form with the new stage set, so every Client Script runs.
function open_form(doctype, name, field, to) {
	const back = frappe.get_route();
	frappe.route_hooks.after_load = (frm) => {
		if (frm.doctype !== doctype || frm.docname !== name) return;
		frm.set_value(field, to);
		frappe.route_hooks.after_save = (f) => {
			if (f.doctype === doctype && f.docname === name) frappe.set_route(back);
		};
	};
	frappe.set_route("Form", doctype, name);
}

// ---------- Kanban v2 ----------

const _init_doctype = frappe.model.init_doctype;
frappe.model.init_doctype = function (meta) {
	const out = _init_doctype.apply(this, arguments);
	try {
		attach_kanban(meta);
	} catch (e) {
		console.error(e);
	}
	return out;
};
Object.values(window.locals?.DocType || {}).forEach(attach_kanban);
frappe.router?.on?.("change", () => {
	const r = frappe.get_route();
	if (r[0] === "List") attach_kanban(window.locals?.DocType?.[r[1]]);
	if (r[0] === "List" && r[2] === "Kanban") board_field();
});

function attach_kanban(meta) {
	if (!meta || meta.istable || meta.issingle || !frappe.kanban_v2?.extend_settings) return;
	if (frappe.kanban_v2.settings[meta.name]?.__nx_rules) return;
	frappe.kanban_v2.extend_settings(meta.name, (base) => {
		const prev = base.callbacks.onBeforeCardMove;
		// the board's check runs first, whatever order the scripts loaded in, so another
		// app's handler sees `move.validated` and shows only its own screens (a PL, say)
		const onBeforeCardMove = async (move) => {
			const ids = move.cardIds || [move.cardId];
			if (!decisions.has(ids)) {
				const decision = before_move(meta.name, ids, move.toColumn, move).catch((e) => {
					console.error(e);
					return false;
				});
				decisions.set(ids, decision);
			}
			const ok = await decisions.get(ids);
			if (ok === false) return false;
			if (ok === true) move.validated = true;
			if (prev && (await prev(move)) === false) return false;
		};
		// a guard written for boards grouped by status (ERPNext's Opportunity one reads card.status)
		// misfires on a board grouped by another field whose column shares a status name
		const prev_can = base.callbacks.canMoveCard;
		const canMoveCard = prev_can
			? (card, from, to) => {
					const field = known_fields[frappe.get_route()[3]];
					if (field && field !== "status" && card && card.status === from) return;
					return prev_can(card, from, to);
			  }
			: undefined;
		const prev_menu = base.card_context_menu;
		const card_context_menu = (card, page) => [
			...((prev_menu && prev_menu(card, page)) || []),
			{
				label: __("Flow"),
				icon: "route",
				condition: () => !!known[meta.name],
				onclick: () => show_flow(meta.name, card.name),
			},
		];
		stage_info(meta.name).then((info) => (known[meta.name] = !!info.flow));
		const callbacks = { ...base.callbacks, onBeforeCardMove };
		if (canMoveCard) callbacks.canMoveCard = canMoveCard;
		return { ...base, __nx_rules: true, card_context_menu, callbacks };
	});
}

// resolves false to cancel the drag, true when the move was checked, undefined when not ours
async function before_move(doctype, ids, to) {
	ids.forEach((id) => pending.delete(`${doctype}::${id}`));
	frappe.provide("nexlify.board");
	window.nx_action_context = nexlify.board.context = { doctype, name: ids[0], names: ids };
	const field = await board_field();
	if (!field || !(await stage_info(doctype)).check_moves) return;
	// the move is checked like a save, so any validation shows here with its buttons
	const answer = await ask_for_move(doctype, ids, field, to, true, true);
	if (answer === "form") open_form(doctype, ids[0], field, to);
	if (!answer || answer === "form") return false;
	for (const [id, values] of Object.entries(answer)) {
		if (Object.keys(values).length) pending.set(`${doctype}::${id}`, { to, values });
	}
	patch_provider();
	if (ids.length === 1 && !(await confirm_move(doctype, ids[0], field, to))) return false;
	return true;
}

// a rule's Confirm View: a screen with Confirm and Cancel before the card moves
async function confirm_move(doctype, name, field, to) {
	const view = await frappe.xcall(API + "confirm_view", { doctype, name, field, to });
	if (!view) return true;
	return new Promise((resolve) => {
		let done = false;
		const d = new frappe.ui.Dialog({
			title: view.title,
			size: "extra-large",
			primary_action_label: view.label,
			primary_action() {
				done = true;
				d.hide();
				resolve(true);
			},
			secondary_action_label: __("Cancel"),
			secondary_action: () => d.hide(),
			onhide: () => !done && resolve(false),
		});
		$(d.body).html(view.html);
		skin(d, { eyebrow: __("Confirm · {0}", [__(doctype)]), to });
		d.show();
	});
}

const known_fields = {}; // board -> its field, once known (canMoveCard can't wait)
function board_field() {
	const board = frappe.get_route()[3];
	if (board && !board_fields[board]) {
		const args = { doctype: "Kanban Board", filters: board, fieldname: "field_name" };
		board_fields[board] = frappe.xcall("frappe.client.get_value", args).then((r) => (known_fields[board] = r?.field_name));
	}
	return board_fields[board] || null;
}

// the popup values are saved in the same request as the move: one save per document
function patch_provider() {
	const P = frappe.kanban_v2?.FrappeDataProvider?.prototype;
	if (!P || P.__nx_rules) return;
	P.__nx_rules = true;
	const { moveCard, moveCards } = P;

	P.moveCard = async function (input) {
		const { doctype, field_name } = this.config;
		const values = take(doctype, input.cardId, input.toColumn);
		if (!values) return moveCard.apply(this, arguments);
		const r = await frappe.xcall(API + "move", {
			doctype,
			names: [input.cardId],
			field: field_name,
			to: input.toColumn,
			values: { [input.cardId]: values },
		});
		return r.saved[input.cardId];
	};

	P.moveCards = async function (ids, to) {
		const { doctype, field_name } = this.config;
		const values = {};
		for (const id of ids) {
			const v = take(doctype, id, to);
			if (v) values[id] = v;
		}
		if (!Object.keys(values).length) return moveCards.apply(this, arguments);
		const r = await frappe.xcall(API + "move", { doctype, names: ids, field: field_name, to, values });
		if (r.failed.length) show_failed(r.failed);
		return { failed: r.failed.map((f) => f.name), saved: r.saved };
	};
}

function take(doctype, id, to) {
	const key = `${doctype}::${id}`;
	const p = pending.get(key);
	pending.delete(key);
	return p && p.to === to ? p.values : null;
}

function show_failed(failed) {
	const esc = frappe.utils.escape_html;
	frappe.msgprint({
		title: __("Not moved"),
		indicator: "orange",
		message: failed.map((f) => `<b>${esc(f.name)}</b>: ${esc(f.error)}`).join("<br>"),
	});
}

// ---------- List view: bulk Edit of a stage field ----------

const _call = frappe.call;
frappe.call = function (opts) {
	const args = opts && typeof opts === "object" && opts.method === BULK ? opts.args : null;
	const data = args && args.action === "update" && typeof args.data === "object" ? args.data : null;
	const keys = data ? Object.keys(data) : [];
	if (keys.length !== 1 || keys[0] === "child_table_updates") return _call.apply(this, arguments);
	return bulk_edit(opts, keys[0], data[keys[0]]);
};

function bulk_edit(opts, field, to) {
	const { doctype, docnames } = opts.args;
	const d = $.Deferred();
	const pass = () => _call(opts).then(d.resolve, d.reject);
	const reopen = () => window.cur_dialog?.enable_primary_action?.(); // the Bulk Edit dialog
	(async () => {
		if (to == null || to === "" || !(await has_rules(doctype, field))) return pass();
		const answer = await ask_for_move(doctype, docnames, field, to, false);
		if (answer === null) return reopen();
		if (!Object.values(answer).some((v) => Object.keys(v).length)) return pass();
		const r = await frappe.xcall(API + "move", { doctype, names: docnames, field, to, values: answer }, "POST", {
			freeze: true,
		});
		// Bulk Edit lists these as "Cannot update …", so each carries its reason
		d.resolve({ message: r.failed.map((f) => `${f.name}: ${f.error}`) });
	})().catch(reopen);
	return d.promise();
}

// ---------- Form: mark the fields the current move needs ----------

const hooked = new Set();
$(document).on("form-refresh", (e, frm) => form_rules(frm));

async function form_rules(frm) {
	if (!frm?.doctype || frm.meta?.istable || frm.meta?.issingle) return;
	const info = await stage_info(frm.doctype);
	if (info.flow && !frm.is_new()) frm.add_custom_button(__("Flow"), () => show_flow(frm.doctype, frm.docname));
	if (!info.stage_fields?.length) return;
	if (!hooked.has(frm.doctype)) {
		hooked.add(frm.doctype);
		const handlers = {};
		for (const f of [...info.stage_fields, ...(info.watch || [])]) handlers[f] = mark_required;
		frappe.ui.form.on(frm.doctype, handlers);
	}
	mark_required(frm);
}

async function mark_required(frm) {
	const need = await background_read(API + "required_in_form", { doc: frm.doc });
	const meta_reqd = (f) => frappe.get_meta(frm.doctype).fields.find((df) => df.fieldname === f)?.reqd;
	for (const f of frm.__nx_reqd || []) {
		if (!need.includes(f) && !meta_reqd(f)) frm.toggle_reqd(f, false);
	}
	need.forEach((f) => frm.toggle_reqd(f, true));
	frm.__nx_reqd = need;
}
