"""Self-test on a real site, run by the install script: bench --site SITE execute nexlify_board.selftest.run

Uses ToDo (in every Frappe site), and rolls everything back at the end."""

import frappe

from nexlify_board import transition_rules as tr


@frappe.whitelist()
def sample_steps(doctype=None, name=None):
	return {"steps": [{"stage": "Closed", "label": "Sample provider step", "done": False, "waiting_on": "Tester"}]}


@frappe.whitelist()
def sample_confirm(doctype=None, name=None, to=None):
	return {"title": "Sample", "html": f"<p>{name} to {to}</p>"}


def run():
	results = []

	def check(label, ok):
		results.append((label, bool(ok)))
		print(("PASS  " if ok else "FAIL  ") + label)

	try:
		_run(check)
	finally:
		frappe.db.rollback()
		tr.clear_cache()
	failed = [label for label, ok in results if not ok]
	if failed:
		raise Exception(f"nexlify_board self-test: {len(failed)} failed: {', '.join(failed)}")
	return f"nexlify_board self-test: {len(results)} passed"


def _rule(**kw):
	doc = frappe.get_doc({"doctype": "Transition Rule", "enabled": 1, "reference_doctype": "ToDo", "stage_field": "status", **kw})
	doc.insert(ignore_permissions=True)
	tr.clear_cache()
	return doc


def _run(check):
	todo = frappe.get_doc({"doctype": "ToDo", "description": "nexlify_board self-test", "status": "Open", "priority": "Medium"})
	todo.insert(ignore_permissions=True)

	_rule(from_value="Open", to_value="Closed", condition='doc.priority == "High"', message="Only high priority closes",
	      action="form", step_label="High priority", sequence=10)
	_rule(from_value="Open", to_value="Cancelled", required_fields=[{"fieldname": "color"}], step_label="Has a color")

	info = tr.get_stage_fields("ToDo")
	check("rules turn on the move check and the Flow", info.get("check_moves") and info.get("flow") and "status" in info["stage_fields"])

	res = tr.check_move("ToDo", [todo.name], "status", "Closed", dry_run=1)
	check("a failed condition blocks the move in the dry run", todo.name in (res.get("errors") or {}))

	todo.reload()
	todo.status = "Closed"
	try:
		todo.save(ignore_permissions=True)
		check("a failed condition blocks the save", False)
	except tr.TransitionRuleError:
		check("a failed condition blocks the save", True)
	todo.reload()

	res = tr.check_move("ToDo", [todo.name], "status", "Cancelled", dry_run=1)
	check("a required field is asked for", "color" in (res.get("docs") or {}).get(todo.name, []))

	# a block the popup's fields can't lift shows before they are asked for
	early = _rule(from_value="Open", to_value="Cancelled", condition='doc.priority == "High"', message="High only")
	res = tr.check_move("ToDo", [todo.name], "status", "Cancelled", dry_run=1)
	check("a block the fields can't lift shows before the popup", todo.name in (res.get("errors") or {}))
	frappe.delete_doc("Transition Rule", early.name, ignore_permissions=True, force=True)
	tr.clear_cache()
	res = tr.check_move("ToDo", [todo.name], "status", "Cancelled", dry_run=1)
	check("fields still to fill don't count as a block", not (res.get("errors") or {}).get(todo.name))

	flow = tr.get_flow("ToDo", todo.name, field="status", to="Closed")
	target = next((s for s in flow.get("stages", []) if s["state"] == "target"), {})
	check("the Flow shows the unmet step", any(x["label"] == "High priority" and not x["done"] for x in target.get("steps", [])))

	settings = frappe.get_single("Nexlify Board Settings")
	settings.set("doctypes", [{"reference_doctype": "ToDo", "check_moves": 1, "flow_method": "nexlify_board.selftest.sample_steps"}])
	settings.save(ignore_permissions=True)
	tr.clear_cache()
	flow = tr.get_flow("ToDo", todo.name, field="status", to="Closed")
	target = next((s for s in flow.get("stages", []) if s["state"] == "target"), {})
	check("the Flow adds steps from the Flow Steps Method", any(x["label"] == "Sample provider step" for x in target.get("steps", [])))

	frappe.db.set_value("ToDo", todo.name, "priority", "High")
	todo.reload()
	res = tr.check_move("ToDo", [todo.name], "status", "Closed", dry_run=1)
	check("a met condition lets the move through", not (res.get("errors") or {}).get(todo.name))

	_rule(from_value="Open", to_value="Closed", confirm_view="nexlify_board.selftest.sample_confirm", confirm_label="Go")
	view = tr.confirm_view("ToDo", todo.name, "status", "Closed")
	check("a Confirm View comes back with its screen", view and "to Closed" in view.get("html", "") and view.get("label") == "Go")

	todo.status = "Closed"
	todo.save(ignore_permissions=True)
	check("the move saves once the condition is met", frappe.db.get_value("ToDo", todo.name, "status") == "Closed")
