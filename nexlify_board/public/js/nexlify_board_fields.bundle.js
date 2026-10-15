// Kanban by any field (Select, Link, Data, Autocomplete, Int). Frappe's board already filters
// each column with `field = column`; this opens the screens that create or edit a board to
// those fields, fills their columns, and shows Link columns by title.
const API = "nexlify_board.kanban_fields.";
const COLUMN_TYPES = ["Select", "Link", "Data", "Autocomplete", "Int"];

function column_field_options(doctype) {
	return frappe
		.get_meta(doctype)
		.fields.filter((df) => df.fieldname && COLUMN_TYPES.includes(df.fieldtype) && !df.hidden)
		.filter((df) => !["kanban_column", "naming_series", "amended_from"].includes(df.fieldname))
		.map((df) => ({ label: `${__(df.label || df.fieldname)} (${__(df.fieldtype)})`, value: df.fieldname }));
}

// 1) "New Kanban Board" from the list view
if (frappe.views.KanbanView) {
	frappe.views.KanbanView.show_kanban_dialog = function (doctype) {
		frappe.model.with_doctype(doctype, () => {
			const options = column_field_options(doctype);
			const dialog = new frappe.ui.Dialog({
				title: __("New Kanban Board"),
				fields: [
					{ fieldtype: "Data", fieldname: "board_name", label: __("Kanban Board Name"), reqd: 1 },
					{
						fieldtype: "Select",
						fieldname: "field_name",
						label: __("Columns based on"),
						options,
						default: (options.find((o) => /status|state/.test(o.value)) || options[0])?.value,
						reqd: 1,
					},
					doctype === "Task"
						? { fieldtype: "Link", fieldname: "project", label: __("Project"), options: "Project" }
						: null,
				].filter(Boolean),
				primary_action_label: __("Save"),
				primary_action(values) {
					frappe.xcall(API + "new_board", { doctype, ...values }).then((board) => {
						dialog.hide();
						frappe.set_route("List", doctype, "Kanban", board.name);
					});
				},
			});
			dialog.show();
		});
	};
}

// 2) Board Settings (Kanban v2): the Column Field list, and columns for non-Select fields
if (frappe.ui.SettingsDialog) {
	const Base = frappe.ui.SettingsDialog;
	frappe.ui.SettingsDialog = class extends Base {
		constructor(opts) {
			try {
				extend_board_settings(opts);
			} catch (e) {
				console.error(e);
			}
			super(opts);
		}
	};
}

function extend_board_settings(opts) {
	const items = (opts?.tabs || []).flatMap((t) => t.items || []);
	const item = items.find((i) => i.id === "columns" && i.fields?.some((f) => f.fieldname === "field_name"));
	const route = frappe.get_route();
	const doctype = route[0] === "List" ? route[1] : null;
	if (!item || !doctype || !locals.DocType[doctype]) return;

	const field = item.fields.find((f) => f.fieldname === "field_name");
	field.options = column_field_options(doctype);
	if (field.default && !field.options.some((o) => o.value === field.default)) {
		field.options.push({ label: field.default, value: field.default });
	}
	field.description = __("The field whose values become the board columns.");

	const render = item.render;
	item.render = (panel) => {
		render && render(panel);
		panel.get_field("field_name")?.$input?.on("change", async () => {
			const fieldname = panel.get_value("field_name");
			const df = frappe.meta.get_docfield(doctype, fieldname);
			if (!df || df.fieldtype === "Select") return; // Frappe fills these from the options
			const values = await frappe.xcall(API + "column_values", { doctype, fieldname });
			const grid = panel.get_field("columns")?.grid;
			if (!grid) return;
			const rows = values.map((v, i) => ({ idx: i + 1, __islocal: true, column_name: v, status: "Active" }));
			grid.df.data.splice(0, grid.df.data.length, ...rows);
			grid.refresh();
		});
	};
}

// 3) Link columns show the record's title (e.g. the project name, not PROJ-0007)
const _require = frappe.require;
frappe.require = function (items, callback) {
	if (![].concat(items).some((i) => String(i).startsWith("kanban.bundle"))) {
		return _require.apply(this, arguments);
	}
	return _require.call(this, items, function () {
		patch_column_titles();
		return callback && callback.apply(this, arguments);
	});
};

function patch_column_titles() {
	const P = frappe.kanban_v2?.FrappeDataProvider?.prototype;
	if (!P || P.__nx_titles) return;
	P.__nx_titles = true;
	const { loadBoard } = P;
	P.loadBoard = async function () {
		const out = await loadBoard.apply(this, arguments);
		const { doctype, field_name } = this.config;
		const df = frappe.meta.get_docfield(doctype, field_name);
		if (df?.fieldtype === "Link" && out.columns.length) {
			const values = out.columns.map((c) => c.id);
			const titles = await frappe
				.xcall(API + "column_titles", { doctype, fieldname: field_name, values })
				.catch(() => ({}));
			out.columns.forEach((c) => (c.title = titles[c.id] || c.title));
		}
		return out;
	};
}
