frappe.ui.form.on("Board Card Layout", {
	refresh: (frm) => set_field_options(frm),
	reference_doctype: (frm) => set_field_options(frm),
	after_save: () => frappe.show_alert({ message: __("Reload the board to see the new card"), indicator: "blue" }),
});

function set_field_options(frm) {
	if (!frm.doc.reference_doctype) return;
	frappe.model.with_doctype(frm.doc.reference_doctype, () => {
		const skip = ["Section Break", "Column Break", "Tab Break", "HTML", "Button", "Table", "Table MultiSelect", "Fold", "Heading", "Image"];
		const all = frappe.get_meta(frm.doc.reference_doctype).fields.filter((d) => d.fieldname && !skip.includes(d.fieldtype));
		const opts = [""].concat(all.map((d) => d.fieldname), ["owner", "modified", "creation"]);
		const nums = [""].concat(all.filter((d) => ["Currency", "Float", "Int", "Percent"].includes(d.fieldtype)).map((d) => d.fieldname));
		frm.fields_dict.fields.grid.update_docfield_property("fieldname", "options", opts);
		frm.set_df_property("title_field", "options", opts);
		frm.set_df_property("progress_value", "options", nums);
		frm.set_df_property("hero_field", "options", nums);
		frm.set_df_property("hero_target", "options", nums);
		frm.set_df_property("progress_target", "options", nums);
		frm.set_df_property("progress_secondary", "options", nums);
	});
}
