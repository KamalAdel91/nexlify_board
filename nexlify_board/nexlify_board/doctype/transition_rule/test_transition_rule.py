"""Who may move: a Transition Rule's Allowed Roles, Allowed Users, user field and Direction, on a
DocType of Frappe's own (ToDo's status), as any app's would be."""

import unittest

import frappe

from nexlify_board.transition_rules import MoveNotAllowed, check_move, clear_cache

MOVER = "nx.mover@example.com"
OTHER = "nx.other@example.com"


def make_user(email, roles):
	if not frappe.db.exists("User", email):
		frappe.get_doc(
			{"doctype": "User", "email": email, "first_name": email.split("@")[0], "send_welcome_email": 0}
		).insert(ignore_permissions=True)
	user = frappe.get_doc("User", email)
	user.add_roles(*roles)
	return user


class TestWhoMayMove(unittest.TestCase):  # no test records: Transition Rule links to DocType and User
	def setUp(self):
		make_user(MOVER, ["Desk User"])
		make_user(OTHER, ["Desk User"])
		frappe.db.delete("Transition Rule", {"reference_doctype": "ToDo"})
		clear_cache()

	def tearDown(self):
		frappe.set_user("Administrator")
		frappe.db.delete("Transition Rule", {"reference_doctype": "ToDo"})
		clear_cache()

	def rule(self, **values):
		values.setdefault("to_value", "Closed")
		rule = frappe.get_doc(
			{
				"doctype": "Transition Rule",
				"enabled": 1,
				"reference_doctype": "ToDo",
				"stage_field": "status",
				**values,
			}
		).insert()
		clear_cache()
		return rule

	def todo(self, user=MOVER, status="Open"):
		frappe.set_user(user)
		try:
			return frappe.get_doc({"doctype": "ToDo", "description": "Who moves me", "status": status}).insert()
		finally:
			frappe.set_user("Administrator")

	def move(self, todo, status, user=MOVER):
		frappe.set_user(user)
		try:
			doc = frappe.get_doc("ToDo", todo.name)
			doc.status = status
			doc.save()
		finally:
			frappe.set_user("Administrator")

	def test_only_the_allowed_roles_move(self):
		self.rule(allowed_roles=[{"role": "System Manager"}])
		todo = self.todo()
		with self.assertRaises(MoveNotAllowed):
			self.move(todo, "Closed")
		make_user(MOVER, ["System Manager"])
		try:
			self.move(todo, "Closed")
		finally:
			frappe.get_doc("User", MOVER).remove_roles("System Manager")

	def test_an_allowed_user_or_the_documents_own_user_moves(self):
		self.rule(allowed_users=[{"user": OTHER}], user_field="allocated_to")
		todo = self.todo()
		frappe.db.set_value("ToDo", todo.name, "allocated_to", MOVER)
		self.move(todo, "Closed")  # its own user
		todo = self.todo()
		with self.assertRaises(MoveNotAllowed):
			self.move(todo, "Closed")  # neither allowed nor its own

	def test_direction_and_the_kanban_check(self):
		self.rule(to_value=None, from_value="Closed", direction="Backward", allowed_roles=[{"role": "System Manager"}])
		todo = self.todo()
		self.move(todo, "Closed")  # forward: the rule is about moving back
		frappe.set_user(MOVER)
		try:
			result = check_move("ToDo", [todo.name], "status", "Open", dry_run=1)
		finally:
			frappe.set_user("Administrator")
		self.assertIn(todo.name, result["errors"])
		with self.assertRaises(MoveNotAllowed):
			self.move(todo, "Open")

	def test_code_saving_for_the_system_and_new_documents_are_not_held(self):
		self.rule(to_value="Closed", allowed_roles=[{"role": "System Manager"}])
		self.todo(status="Closed")  # new: Apply on Create is off
		todo = self.todo()
		frappe.set_user(MOVER)
		try:
			doc = frappe.get_doc("ToDo", todo.name)
			doc.status = "Closed"
			doc.flags.ignore_permissions = True
			doc.save()
		finally:
			frappe.set_user("Administrator")
		self.assertEqual(frappe.db.get_value("ToDo", todo.name, "status"), "Closed")
