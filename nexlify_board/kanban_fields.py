"""Kanban columns from any field, not only Select.

Frappe's Kanban already filters each column with `field = column`, whatever the field
type; only the screens that create a board offer Select fields alone. These helpers give
those screens their starting columns for Link, Data, Autocomplete and Int fields.
"""

import frappe
from frappe import _
from frappe.utils import cint, cstr

COLUMN_FIELDTYPES = ("Select", "Link", "Data", "Autocomplete", "Int")
MAX_COLUMNS = 40


def column_field(doctype, fieldname):
	df = frappe.get_meta(doctype).get_field(fieldname)
	if not df or df.fieldtype not in COLUMN_FIELDTYPES:
		frappe.throw(_("{0} can't be used for Kanban columns").format(frappe.bold(fieldname)))
	return df


@frappe.whitelist()
def column_values(doctype: str, fieldname: str):
	"""Select: its options. Other fields: the values in use, most used first; and for a Link
	to a short list (Territory, Sales Person, a few Projects) every record you can read."""
	frappe.has_permission(doctype, "read", throw=True)
	df = column_field(doctype, fieldname)
	if df.fieldtype == "Select":
		return [o.strip() for o in (df.options or "").split("\n") if o.strip()]

	rows = frappe.get_all(
		doctype,
		fields=[f"{fieldname} as value", {"COUNT": "*", "as": "count"}],
		filters=[[fieldname, "is", "set"]],
		group_by=fieldname,
		order_by=None,
		limit=0,
	)
	values = [cstr(r.value) for r in sorted(rows, key=lambda r: -cint(r.count))]
	if df.fieldtype == "Link" and frappe.db.count(df.options) <= MAX_COLUMNS:
		for name in frappe.get_list(df.options, pluck="name", order_by="name asc", limit=MAX_COLUMNS):
			if name not in values:
				values.append(name)
	return values[:MAX_COLUMNS]


@frappe.whitelist()
def column_titles(doctype: str, fieldname: str, values):
	"""Titles for Link columns when the linked DocType shows titles in links (Project, Customer…)."""
	values = frappe.parse_json(values) or []
	df = frappe.get_meta(doctype).get_field(fieldname)
	if not values or not df or df.fieldtype != "Link":
		return {}
	meta = frappe.get_meta(df.options)
	if not (meta.show_title_field_in_link and meta.title_field):
		return {}
	rows = frappe.get_list(
		df.options, filters={"name": ["in", values]}, fields=["name", meta.title_field], limit=0
	)
	return {r.name: r.get(meta.title_field) for r in rows if r.get(meta.title_field)}


@frappe.whitelist()
def new_board(doctype: str, board_name: str, field_name: str, project: str | None = None):
	"""Frappe's quick board, for any column field."""
	column_field(doctype, field_name)
	board = frappe.new_doc("Kanban Board")
	board.kanban_board_name = board_name
	board.reference_doctype = doctype
	board.field_name = field_name
	if project:
		board.filters = frappe.as_json([[doctype, "project", "=", project]])
	for value in column_values(doctype, field_name):
		board.append("columns", {"column_name": value})
	if doctype in ("Note", "ToDo"):
		board.private = 1
	board.insert()
	return board
