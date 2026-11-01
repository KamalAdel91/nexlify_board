import frappe
from frappe.model.document import Document


class BoardCardLayout(Document):
	# the layouts reach the browser in the boot (nexlify_board.board_cards.boot), which Frappe keeps per user:
	# a change shows on everyone's next page load
	def on_update(self):
		frappe.cache.delete_key("bootinfo")

	def on_trash(self):
		frappe.cache.delete_key("bootinfo")
