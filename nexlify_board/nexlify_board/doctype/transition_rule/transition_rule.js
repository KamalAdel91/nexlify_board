// Stage Field, the required-field picker and the user field list the chosen DocType's fields.
frappe.ui.form.on("Transition Rule", {
	refresh(frm) {
		set_field_options(frm);
	},
	reference_doctype(frm) {
		frm.set_value("stage_field", "");
		set_field_options(frm);
	},
});

function set_field_options(frm) {
	const doctype = frm.doc.reference_doctype;
	if (!doctype) return;
	frappe.model.with_doctype(doctype, () => {
		const skip = new Set([...frappe.model.layout_fields, "HTML", "Button", "Heading", "Image"]);
		const options = frappe
			.get_meta(doctype)
			.fields.filter((df) => df.fieldname && !skip.has(df.fieldtype))
			.map((df) => ({ label: `${__(df.label || df.fieldname)} (${df.fieldname})`, value: df.fieldname }));
		frm.set_df_property("stage_field", "options", [{ label: "", value: "" }, ...options]);
		frm.fields_dict.required_fields.grid.update_docfield_property("fieldname", "options", options);
		frm.refresh_field("required_fields");
		// Or the Document's Own User: the document's User fields, and Created By
		const users = frappe
			.get_meta(doctype)
			.fields.filter((df) => df.fieldtype === "Link" && df.options === "User")
			.map((df) => ({ label: `${__(df.label || df.fieldname)} (${df.fieldname})`, value: df.fieldname }));
		frm.set_df_property("user_field", "options", [
			{ label: "", value: "" },
			{ label: `${__("Created By")} (owner)`, value: "owner" },
			...users,
		]);
	});
}
