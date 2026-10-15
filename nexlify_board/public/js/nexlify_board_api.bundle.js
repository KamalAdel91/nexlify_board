// nexlify.board: Kanban events for Client Scripts (nexlify.kanban is the same object).
//
// A Client Script with view "List" runs when the DocType loads, Kanban included, so it can do:
//
//   nexlify.board.on("Opportunity", {
//       async before_move(ctx) { if (!ok) return false; },    // false cancels the drag
//       after_move(ctx) {},
//       card_menu(ctx) { return [{ label: "Do it", icon: "zap", action: () => {} }]; },
//       card_badges(ctx) { return [{ label: ctx.card.status, theme: "green", tooltip: "..." }]; },
//   });
//
// ctx: { doctype, name, names, from, to, card, page, refresh() }. Handlers from several
// scripts and apps stack: each runs, and any before_move returning false cancels.
(() => {
	frappe.provide("nexlify.board");
	nexlify.kanban = nexlify.board; // the earlier name, kept for scripts that use it

	const has_kanban = () => !!frappe.kanban_v2?.extend_settings;

	function move_ctx(doctype, move) {
		return {
			doctype,
			name: move.cardId,
			names: move.cardIds || [move.cardId],
			from: move.fromColumn,
			to: move.toColumn,
			move,
		};
	}

	function card_ctx(doctype, card, page) {
		return { doctype, card, name: card.name, page, refresh: () => page?.board?.refresh?.() };
	}

	function badge_row(badges) {
		const row = document.createElement("div");
		row.className = "flex flex-wrap items-center gap-1 mt-2";
		badges.forEach((b) => {
			if (!b || !b.label) return;
			const el = frappe.ui.badge({
				label: b.label,
				theme: b.theme || "gray",
				variant: b.variant,
				icon: b.icon,
				size: b.size || "sm",
			})[0];
			if (b.tooltip) frappe.ui.tooltip(el, { text: b.tooltip });
			row.appendChild(el);
		});
		return row;
	}

	// ---------- action buttons ----------
	//
	// Any message (frappe.throw from a Server Script, a Transition Rule, a msgprint) can carry
	//   <button data-nx-action="NAME" data-doctype="DT" data-name="NAME">Label</button>
	// Clicking it closes the message and runs the action for the document it is about:
	// the button's data-doctype/data-name, else window.nx_action_context, else the open form.
	//   form                 open the document
	//   route:/app/...       go to a page
	//   map:dotted.method    make a mapped document (e.g. a Quotation from an Opportunity)
	//   any other NAME       a function in window.nx_actions: (ctx) => {...}
	// ctx: { doctype, name, frm, refresh() }
	//
	// The registry, the context and the click handler live on `window`, not in this app: any
	// app can register actions or show such buttons with or without Nexlify Board installed.
	// Whichever app loads first installs the one click handler; they all behave the same.
	window.nx_actions = window.nx_actions || {};
	nexlify.board.action = (name, fn) => {
		window.nx_actions[name] = fn;
	};
	nexlify.board.has_action = (name) => !!window.nx_actions[name];
	nexlify.board.context = null; // { doctype, name, names } of the card being moved

	function action_ctx(el) {
		const frm = window.cur_frm;
		const moving = window.nx_action_context || nexlify.board.context;
		const doctype = el?.dataset.doctype || moving?.doctype || frm?.doctype;
		const name = el?.dataset.name || moving?.name || frm?.docname;
		const form = frm && frm.doctype === doctype && frm.docname === name ? frm : null;
		const refresh = () => {
			if (form) return form.reload_doc();
			window.cur_list?.board?.refresh?.();
			window.cur_list?.refresh?.();
		};
		return { doctype, name, frm: form, refresh };
	}

	function run_action(action, ctx) {
		action = (action || "").trim();
		if (!action) return;
		if (action === "form") return frappe.set_route("Form", ctx.doctype, ctx.name);
		if (action.startsWith("fields:") && window.nx_edit_fields) {
			const fields = action.slice(7).split(",").map((f) => f.trim()).filter(Boolean);
			return window.nx_edit_fields(ctx.doctype, ctx.name, fields, ctx.refresh);
		}
		if (action.startsWith("move:")) return move_action(action.slice(5), ctx);
		if (action.startsWith("call:")) return call_action(action.slice(5), ctx);
		if (action.startsWith("route:")) return frappe.set_route(action.slice(6).replace(/^\/app\//, ""));
		if (action.startsWith("map:")) {
			const method = action.slice(4);
			return ctx.frm
				? frappe.model.open_mapped_doc({ method, frm: ctx.frm })
				: frappe.model.open_mapped_doc({ method, source_name: ctx.name });
		}
		const fn = window.nx_actions[action];
		// registered by a script that isn't loaded on this page: the form is the safe fallback
		if (!fn) return frappe.set_route("Form", ctx.doctype, ctx.name);
		return fn(ctx);
	}
	// call:method?arg=value&arg2={name}: a whitelisted method or an API Server Script, with the
	// document's {name} and {doctype} filled in; its message (if any) shows, then the view refreshes
	function call_action(spec, ctx) {
		const [method, query = ""] = spec.split("?");
		const args = {};
		new URLSearchParams(query).forEach((v, k) => {
			args[k] = v.replace(/\{name\}/g, ctx.name).replace(/\{doctype\}/g, ctx.doctype);
		});
		if (!Object.keys(args).length) Object.assign(args, { doctype: ctx.doctype, name: ctx.name });
		return frappe.call({ method, args, freeze: true }).then((r) => {
			const out = r.message && r.message.result !== undefined ? r.message.result : r.message;
			if (out && typeof out === "object" && out.message) frappe.show_alert({ message: out.message, indicator: "green" });
			else frappe.show_alert({ message: __("Done"), indicator: "green" });
			ctx.refresh();
		});
	}
	// move:field=value moves the document the way a Kanban drag does: the fields the stage needs
	// are asked for in the same popup, a block shows the Flow, then it is saved once
	async function move_action(spec, ctx) {
		const i = spec.indexOf("=");
		if (i < 0) return frappe.msgprint(__("Write the move as field=value"));
		const field = spec.slice(0, i).trim();
		const to = spec.slice(i + 1).trim();
		let values = {};
		if (window.nx_move) {
			const res = await window.nx_move(ctx.doctype, [ctx.name], field, to, true, true);
			if (res === null || res === undefined) return;
			if (res === "form") return frappe.set_route("Form", ctx.doctype, ctx.name);
			values = res;
		}
		await frappe.xcall("nexlify_board.transition_rules.move", { doctype: ctx.doctype, names: [ctx.name], field, to, values });
		frappe.show_alert({ message: __("Moved to {0}", [__(to)]), indicator: "green" });
		ctx.refresh();
	}
	// Nexlify Board loads before any Client Script, so its runner (which knows fields: and call:)
	// is the one installed; scripts that bring their own only fill the gap when it's absent
	window.nx_run_action = run_action;
	nexlify.board.run_action = (action, ctx) => window.nx_run_action(action, ctx || action_ctx(null));

	if (!window.__nx_action_click) {
		window.__nx_action_click = true;
		$(document).on("click", "[data-nx-action]", function (e) {
			e.preventDefault();
			const ctx = action_ctx(this);
			const action = this.dataset.nxAction;
			$(this).closest(".modal").modal("hide");
			window.nx_run_action(action, ctx);
		});
	}

	nexlify.board.on = function (doctype, handlers = {}) {
		if (!has_kanban()) return;
		frappe.kanban_v2.extend_settings(doctype, (base) => {
			const callbacks = { ...(base.callbacks || {}) };
			const out = { ...base, callbacks };

			if (handlers.before_move) {
				const prev = callbacks.onBeforeCardMove;
				callbacks.onBeforeCardMove = async (move) => {
					if (prev && (await prev(move)) === false) return false;
					try {
						return (await handlers.before_move(move_ctx(doctype, move))) === false ? false : undefined;
					} catch (e) {
						console.error(e);
						return false;
					}
				};
			}

			if (handlers.after_move) {
				const prev = callbacks.onAfterCardMove;
				callbacks.onAfterCardMove = (move) => {
					prev && prev(move);
					try {
						handlers.after_move(move_ctx(doctype, move));
					} catch (e) {
						console.error(e);
					}
				};
			}

			if (handlers.card_menu) {
				const prev = base.card_context_menu;
				out.card_context_menu = (card, page) => {
					const items = (prev && prev(card, page)) || [];
					let extra = [];
					try {
						extra = handlers.card_menu(card_ctx(doctype, card, page)) || [];
					} catch (e) {
						console.error(e);
					}
					return [
						...items,
						...extra.map((i) => ({
							label: i.label,
							icon: i.icon,
							theme: i.theme,
							condition: i.condition,
							onclick: i.onclick || i.action,
						})),
					];
				};
			}

			if (handlers.card_badges) {
				const prev = base.renderCard;
				out.renderCard = (card, el, ctx, page) => {
					prev ? prev(card, el, ctx, page) : page.render_card(card, el);
					try {
						const badges = handlers.card_badges(card_ctx(doctype, card, page)) || [];
						if (badges.length) el.appendChild(badge_row(badges));
					} catch (e) {
						console.error(e);
					}
				};
			}

			return out;
		});
	};
})();


// A blocked move's Flow screen: once one of its steps is done from there, the same move is tried again
// (the move popup asks for the stage's fields; a step still missing shows the Flow again)
(() => {
	let pending = null;
	const orig_xcall = frappe.xcall;
	frappe.xcall = function (method, args, ...rest) {
		const p = orig_xcall.call(this, method, args, ...rest);
		if (method === "nexlify_board.transition_rules.get_flow" && args && args.to) {
			Promise.resolve(p)
				.then((r) => {
					if (r && r.field && r.target)
						pending = { doctype: args.doctype, name: args.name, field: r.field, to: r.target, at: Date.now() };
				})
				.catch(() => {});
		}
		return p;
	};
	const refresh_views = (p) => {
		window.cur_list?.board?.refresh?.();
		window.cur_list?.refresh?.();
		if (window.cur_frm && cur_frm.doctype === p.doctype && cur_frm.docname === p.name) cur_frm.reload_doc();
	};
	async function resume(ctx) {
		const p = pending;
		if (!p || p.doctype !== ctx.doctype || p.name !== ctx.name || Date.now() - p.at > 10 * 60 * 1000) return;
		pending = null;
		let values = {};
		if (window.nx_move) {
			const res = await window.nx_move(p.doctype, [p.name], p.field, p.to, true, true);
			if (res === null || res === undefined) return;
			if (res === "form") return frappe.set_route("Form", p.doctype, p.name);
			values = res;
		}
		await frappe.xcall("nexlify_board.transition_rules.move", { doctype: p.doctype, names: [p.name], field: p.field, to: p.to, values });
		frappe.show_alert({ message: __("Moved to {0}", [__(p.to)]), indicator: "green" });
		refresh_views(p);
	}
	function wrap() {
		const run = window.nx_run_action;
		if (!run || run.__nx_resume) return;
		const wrapped = function (action, ctx) {
			if (ctx && pending) {
				const done = ctx.refresh;
				const c = ctx;
				ctx = { ...ctx, refresh: () => { done && done(); setTimeout(() => resume(c), 400); } };
			}
			return run(action, ctx);
		};
		wrapped.__nx_resume = true;
		window.nx_run_action = wrapped;
	}
	wrap();
	setTimeout(wrap, 2000);
})();


// A save blocked for missing stage fields (stage changed in the form, or by a button): the move popup
// opens instead of the message, and the move is made once the fields are filled
(() => {
	const MARK = /\s*\[\[nx-move:([^|\]]*)\|([^|\]]*)\|([^|\]]*)\|([^\]]*)\]\]/;
	const orig = frappe.msgprint;
	frappe.msgprint = function (msg, ...rest) {
		const text = typeof msg === "string" ? msg : msg && msg.message;
		const m = text && String(text).match(MARK);
		if (m) {
			const [, doctype, name, field, to] = m;
			if (window.nx_move) {
				setTimeout(async () => {
					const res = await window.nx_move(doctype, [name], field, to, true, true);
					if (res === null || res === undefined) return;
					if (res === "form") return frappe.set_route("Form", doctype, name);
					await frappe.xcall("nexlify_board.transition_rules.move", { doctype, names: [name], field, to, values: res });
					frappe.show_alert({ message: __("Moved to {0}", [__(to)]), indicator: "green" });
					window.cur_list?.board?.refresh?.();
					window.cur_list?.refresh?.();
					if (window.cur_frm && cur_frm.doctype === doctype && cur_frm.docname === name) cur_frm.reload_doc();
				}, 50);
				return;
			}
			const clean = String(text).replace(MARK, "");
			msg = typeof msg === "string" ? clean : { ...msg, message: clean };
		}
		return orig.call(this, msg, ...rest);
	};
	Object.assign(frappe.msgprint, orig);
})();


// The form behaves like the board: a stage changed in the form goes through the same check before
// saving — the move popup asks for the stage's fields (filled into the form), a blocked step shows the Flow
(() => {
	if (window.__nx_form_save) return;
	window.__nx_form_save = true;
	const stage_fields = {};
	const fields_of = (doctype) =>
		(stage_fields[doctype] =
			stage_fields[doctype] ||
			frappe
				.xcall("nexlify_board.transition_rules.get_stage_fields", { doctype })
				.then((r) => (r && r.stage_fields) || [])
				.catch(() => []));
	$(document).on("form-refresh", (e, frm) => {
		if (frm && frm.doc) frm.__nx_saved = { ...frm.doc };
	});
	const hook = () => {
		const F = frappe.ui.form && frappe.ui.form.Form;
		if (!F || F.prototype.__nx_save) return !!F;
		const orig = F.prototype.save;
		F.prototype.save = function (action, ...rest) {
			const frm = this;
			const go = () => orig.call(frm, action, ...rest);
			if (frm.__nx_ok || frm.is_new() || (action && action !== "Save") || !frm.__nx_saved || !window.nx_move) {
				frm.__nx_ok = false;
				return go();
			}
			return fields_of(frm.doctype).then(async (fields) => {
				const f = fields.find((x) => frm.doc[x] && frm.doc[x] !== frm.__nx_saved[x]);
				if (!f) return go();
				const res = await window.nx_move(frm.doctype, [frm.docname], f, frm.doc[f], false, true);
				if (res === null || res === undefined || res === "form") return;
				for (const [k, v] of Object.entries(res[frm.docname] || {})) {
					if (v !== undefined && k !== f) await frm.set_value(k, v);
				}
				frm.__nx_ok = true;
				return go();
			});
		};
		F.prototype.__nx_save = true;
		return true;
	};
	if (!hook()) {
		let n = 0;
		const t = setInterval(() => (hook() || ++n > 50) && clearInterval(t), 200);
	}
})();
