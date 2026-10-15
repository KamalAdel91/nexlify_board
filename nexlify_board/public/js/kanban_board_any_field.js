// Kanban Board form: any column field, with columns filled from that field's values.
// Runs after Frappe's own Kanban Board script, so these handlers win.
frappe.ui.form.on("Kanban Board", {
	refresh(frm) {
		nx_column_field_options(frm);
	},
	reference_doctype(frm) {
		nx_column_field_options(frm);
	},
	field_name(frm) {
		const { reference_doctype: doctype, field_name: fieldname } = frm.doc;
		const df = doctype && frappe.meta.get_docfield(doctype, fieldname);
		if (!df || df.fieldtype === "Select") return; // Frappe fills these from the options
		frappe.xcall("nexlify_board.kanban_fields.column_values", { doctype, fieldname }).then((values) => {
			frm.clear_table("columns");
			values.forEach((v) => frm.add_child("columns", { column_name: v }));
			frm.refresh_field("columns");
		});
	},
});

function nx_column_field_options(frm) {
	const doctype = frm.doc.reference_doctype;
	if (!doctype) return;
	frappe.model.with_doctype(doctype, () => {
		const types = ["Select", "Link", "Data", "Autocomplete", "Int"];
		const options = frappe
			.get_meta(doctype)
			.fields.filter((df) => df.fieldname && types.includes(df.fieldtype) && !df.hidden)
			.map((df) => df.fieldname);
		if (frm.doc.field_name && !options.includes(frm.doc.field_name)) options.push(frm.doc.field_name);
		frm.set_df_property("field_name", "options", options);
	});
}
