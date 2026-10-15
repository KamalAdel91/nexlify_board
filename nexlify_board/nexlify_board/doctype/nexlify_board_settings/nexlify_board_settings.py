import frappe
from frappe import _
from frappe.model.document import Document

from nexlify_board.transition_rules import clear_cache


class NexlifyBoardSettings(Document):
	def validate(self):
		seen = set()
		for row in self.doctypes:
			if row.reference_doctype in seen:
				frappe.throw(_("Row {0}: {1} is listed twice").format(row.idx, frappe.bold(row.reference_doctype)))
			seen.add(row.reference_doctype)
			row.flow_method = (row.flow_method or "").strip()

	def on_update(self):
		clear_cache()
