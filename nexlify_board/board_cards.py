import json
import frappe

LAYOUT_KEYS = ("replace_card", "title_field", "show_name", "compact_numbers", "show_stage_path", "stage_labels", "path_style", "dedupe_actions", "form_actions",
               "hero_field", "hero_target", "hero_target_label", "hero_note",
               "progress_value", "progress_target", "progress_label",
               "progress_title", "progress_secondary", "progress_secondary_label", "progress_condition",
               "column_titles", "column_color_field", "column_title_font")
FIELD_KEYS = ("fieldname", "label", "show_as", "position", "badge_colors", "condition")
RULE_KEYS = ("condition", "color", "badge", "badge_theme")
ACTION_KEYS = ("label", "action", "condition", "style")


def get_layouts_data():
	if not frappe.db.table_exists("Board Card Layout"):
		return {}
	out = {}
	for name in frappe.get_all("Board Card Layout", filters={"enabled": 1}, pluck="name"):
		d = frappe.get_cached_doc("Board Card Layout", name)
		layout = {k: d.get(k) for k in LAYOUT_KEYS}
		layout["fields"] = [{k: f.get(k) for k in FIELD_KEYS} for f in d.fields]
		layout["rules"] = [{k: r.get(k) for k in RULE_KEYS} for r in d.rules]
		layout["actions"] = [{k: a.get(k) for k in ACTION_KEYS} for a in d.get("actions") or []]
		layout["next_steps"] = [{k: x.get(k) for k in ("condition", "text", "button_label", "action", "tone")}
		                        for x in d.get("next_steps") or []]
		layout["checklist"] = [{k: x.get(k) for k in ("label", "done_when", "only_when")}
		                       for x in d.get("checklist") or []]
		out[d.reference_doctype] = layout
	return out


def boot(bootinfo):
	try:
		bootinfo.nx_card_layouts = get_layouts_data()
	except Exception:
		frappe.log_error("Nexlify Board: card layouts")


@frappe.whitelist()
def get_layouts():
	return get_layouts_data()


@frappe.whitelist()
def stage_history(doctype, names, field):
	"""Each document's path through `field`: [{stage, on}], oldest first, from its Version log."""
	names = frappe.parse_json(names) or []
	out = {n: [] for n in names}
	if not names or not frappe.has_permission(doctype, "read"):
		return out
	for r in frappe.get_all("Version", filters={"ref_doctype": doctype, "docname": ["in", names]},
	                        fields=["docname", "data", "creation"], order_by="creation asc", limit=10000):
		try:
			data = json.loads(r.data or "{}")
		except Exception:
			continue
		for ch in data.get("changed") or []:
			if ch and ch[0] == field and r.docname in out:
				out[r.docname].append({"stage": ch[2], "from": ch[1], "on": str(r.creation)})
	for row in frappe.get_all(doctype, filters={"name": ["in", names]}, fields=["name", "creation", field]):
		steps = out[row.name]
		first = steps[0]["from"] if steps else row.get(field)
		steps.insert(0, {"stage": first, "from": None, "on": str(row.creation)})
	return out
