"""Helpers for installing and wiring Nexlify Board on a site, run with `bench execute`.

	bench --site SITE execute nexlify_board.setup.site_needs_board
	bench --site SITE execute nexlify_board.setup.add_doctype --kwargs "{'doctype': 'Opportunity', 'flow_method': 'eye.flow'}"
	bench --site SITE execute nexlify_board.setup.remove_rules --kwargs "{'doctype': 'Opportunity'}"
"""

import frappe

from nexlify_board.transition_rules import clear_cache


def site_needs_board():
	"""True when the site uses what Nexlify Board now holds: Transition Rules, or a Kanban
	board whose columns come from a field that isn't a Select."""
	if frappe.db.table_exists("Transition Rule") and frappe.db.count("Transition Rule"):
		return True
	for board in frappe.get_all("Kanban Board", fields=["reference_doctype", "field_name"]):
		try:
			df = frappe.get_meta(board.reference_doctype).get_field(board.field_name)
		except Exception:
			continue
		if df and df.fieldtype != "Select":
			return True
	return False


def add_doctype(doctype, flow_method=None, check_moves=1):
	"""Add or update a DocType's row in Nexlify Board Settings."""
	settings = frappe.get_single("Nexlify Board Settings")
	row = next((r for r in settings.doctypes if r.reference_doctype == doctype), None)
	if not row:
		row = settings.append("doctypes", {"reference_doctype": doctype})
	row.check_moves = frappe.utils.cint(check_moves)
	row.flow_method = flow_method or ""
	settings.save(ignore_permissions=True)
	frappe.db.commit()
	clear_cache()
	return f"{doctype}: check_moves={row.check_moves} flow_method={row.flow_method or '-'}"


def remove_rules(doctype):
	"""Delete every Transition Rule of a DocType (when an app now checks those moves itself)."""
	names = frappe.get_all("Transition Rule", filters={"reference_doctype": doctype}, pluck="name")
	for name in names:
		frappe.delete_doc("Transition Rule", name, ignore_permissions=True, force=True)
	frappe.db.commit()
	clear_cache()
	return f"{doctype}: removed {len(names)} rule(s)"
