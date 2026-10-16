// Nexlify Board: Kanban cards drawn from "Board Card Layout" records (title, badges, numbers,
// progress, dates, color rules). Frappe reads frappe.kanban_v2.settings[doctype] when a board
// opens; the renderer sits there from boot and survives later assignments and extend_settings.
(() => {
	const SYS = ["name", "owner", "modified", "creation"];
	const LINE = "var(--outline-gray-1, var(--border-color, rgba(128,128,128,.2)))";
	const MUTED = "var(--ink-gray-5, var(--text-muted))";
	const STRONG = "var(--ink-gray-9, var(--heading-color, var(--text-color)))";
	const TONE = { green: "var(--green-500, #2f9e44)", orange: "var(--orange-500, #f59f00)", red: "var(--red-500, #e03636)" };
	const cache = {};
	const queues = {};

	const make = (tag, cls, style) => {
		const d = document.createElement(tag);
		if (cls) d.className = cls;
		if (style) d.style.cssText = style;
		return d;
	};
	const esc = (s) => frappe.utils.escape_html(String(s == null ? "" : s));
	const has = (dt, f) => !!f && (SYS.includes(f) || !!frappe.meta.get_docfield(dt, f));
	const df_of = (dt, f) => frappe.meta.get_docfield(dt, f) || { fieldtype: "Data", fieldname: f };
	const badge = (opts) => frappe.ui.badge({ size: "sm", theme: "gray", ...opts })[0];

	function needed(dt, layout) {
		const need = new Set(["name"]);
		const add = (f) => {
			if (!has(dt, f)) return;
			need.add(f);
			const df = df_of(dt, f);
			if (df.fieldtype === "Currency" && df.options && has(dt, df.options)) need.add(df.options);
		};
		const scan = (cond) => (cond || "").replace(/doc\.(\w+)/g, (_, x) => (add(x), ""));
		(layout.fields || []).forEach((f) => {
			add(f.fieldname);
			scan(f.condition);
		});
		(layout.rules || []).forEach((r) => scan(r.condition));
		(layout.actions || []).forEach((x) => scan(x.condition));
		[layout.title_field, layout.progress_value, layout.progress_target, layout.hero_field, layout.hero_target, "currency"].forEach(add);
		const tpl = (t) => (t || "").replace(/\{(\w+)\}/g, (_, x) => (add(x), ""));
		scan(layout.hero_note);
		scan(layout.progress_condition);
		add(layout.progress_secondary);
		tpl(layout.hero_note);
		(layout.next_steps || []).forEach((x) => { scan(x.condition); scan(x.text); tpl(x.text); });
		(layout.checklist || []).forEach((x) => { scan(x.label); tpl(x.label); scan(x.done_when); scan(x.only_when); });
		return [...need];
	}

	function fetch_row(dt, layout, name, ver) {
		const c = (cache[dt] = cache[dt] || {});
		if (c[name] && c[name].ver === (ver || "") && Date.now() - c[name].at < 30000) return c[name].p;
		const q = (queues[dt] = queues[dt] || { names: new Set(), waiters: {} });
		q.names.add(name);
		const p = new Promise((res) => (q.waiters[name] = q.waiters[name] || []).push(res));
		c[name] = { at: Date.now(), p, ver: ver || "" };
		clearTimeout(q.t);
		q.t = setTimeout(() => {
			const names = [...q.names];
			const waiters = q.waiters;
			queues[dt] = { names: new Set(), waiters: {} };
			const done = (by) => names.forEach((n) => (waiters[n] || []).forEach((fn) => fn(by[n] || null)));
			frappe.db
				.get_list(dt, { filters: { name: ["in", names] }, fields: needed(dt, layout), limit: names.length })
				.then((rows) => done(Object.fromEntries(rows.map((r) => [r.name, r]))))
				.catch((e) => {
					console.error("Nexlify Board cards: could not read", dt, e);
					done({});
				});
		}, 40);
		return p;
	}

	function test(cond, doc) {
		cond = (cond || "").trim();
		if (!cond) return true;
		if (cond.startsWith("eval:")) cond = cond.slice(5);
		try {
			return !!new Function("doc", "frappe", "flt", "cint", `return (${cond});`)(doc, frappe, flt, cint);
		} catch (e) {
			return false;
		}
	}
	const color_map = (text) =>
		Object.fromEntries(
			(text || "")
				.split("\n")
				.map((l) => [l.slice(0, l.lastIndexOf("=")).trim(), l.slice(l.lastIndexOf("=") + 1).trim()])
				.filter(([k]) => k)
		);

	function currency_of(df, doc) {
		const o = df.options;
		if (o && doc[o]) return doc[o];
		if (o && /^[A-Z]{3}$/.test(o)) return o;
		return doc.currency || frappe.defaults.get_default("currency");
	}
	function number_text(v, df, doc, compact) {
		const n = flt(v);
		const is_cur = df.fieldtype === "Currency";
		const cur = is_cur ? currency_of(df, doc) : null;
		const full = is_cur ? format_currency(n, cur) : $("<div>").html(frappe.format(n, df, { inline: true }, doc)).text();
		if (!compact || Math.abs(n) < 10000) return { text: is_cur ? format_currency(n, cur, 0) : full, full };
		const c = new Intl.NumberFormat(undefined, { notation: "compact", maximumFractionDigits: 1 }).format(n);
		return { text: is_cur ? `${get_currency_symbol(cur) || cur} ${c}` : c, full };
	}
	function date_badge(v, label) {
		const days = frappe.datetime.get_day_diff(v, frappe.datetime.get_today());
		const text =
			days === 0 ? __("Today")
			: days === 1 ? __("Tomorrow")
			: days > 1 ? __("in {0} days", [days])
			: __("{0} days late", [-days]);
		const b = badge({ icon: "calendar", label: text, theme: days < 0 ? "red" : days <= 3 ? "orange" : "gray", variant: days < 0 ? "subtle" : "ghost" });
		frappe.ui.tooltip(b, { text: `${label}: ${frappe.datetime.str_to_user(v)}` });
		return b;
	}
	function user_avatar(page, user, label) {
		let a = null;
		try {
			a = page && page.assignee_avatar ? page.assignee_avatar(user, "sm") : null;
		} catch (e) {
			a = null;
		}
		if (!a) {
			a = make("span");
			a.innerHTML = frappe.avatar(user, "avatar-xs");
		}
		frappe.ui.tooltip(a, { text: `${label}: ${frappe.user.full_name(user)}` });
		return a;
	}

	const hist_cache = {};
	const hist_q = {};
	function fetch_history(dt, field, name, ver) {
		const key = dt + "|" + field;
		const c = (hist_cache[key] = hist_cache[key] || {});
		if (c[name] && c[name].ver === (ver || "")) return c[name].p;
		const q = (hist_q[key] = hist_q[key] || { names: new Set(), waiters: {} });
		q.names.add(name);
		const p = new Promise((res) => (q.waiters[name] = q.waiters[name] || []).push(res));
		c[name] = { p, ver: ver || "" };
		clearTimeout(q.t);
		q.t = setTimeout(() => {
			const names = [...q.names];
			const waiters = q.waiters;
			hist_q[key] = { names: new Set(), waiters: {} };
			const done = (all) => names.forEach((n) => (waiters[n] || []).forEach((fn) => fn((all || {})[n] || [])));
			frappe.xcall("nexlify_board.board_cards.stage_history", { doctype: dt, names, field }).then(done).catch(() => done({}));
		}, 60);
		return p;
	}

	function fill(text, dt, doc) {
		let any = false;
		let empty = true;
		const out = String(text || "").replace(/\{=([^}]+)\}|\{(\w+)\}/g, (_, expr, f) => {
			any = true;
			let v;
			if (expr) {
				try {
					v = new Function("doc", "frappe", "flt", "cint", `return (${expr});`)(doc, frappe, flt, cint);
				} catch (e) {
					v = "";
				}
			} else {
				v = doc[f];
			}
			if (v !== null && v !== undefined && v !== "" && v !== 0) empty = false;
			if (typeof v === "number") {
				const df = f ? df_of(dt, f) : { fieldtype: doc.currency ? "Currency" : "Float", options: "currency" };
				if (df.fieldtype === "Percent") return String(Math.round(v));
				if (df.fieldtype === "Currency") return number_text(v, df, doc, true).text;
				return String(Math.round(v * 100) / 100);
			}
			if (f && v && df_of(dt, f).fieldtype === "Date") return frappe.datetime.str_to_user(v);
			return v == null ? "" : String(__(v));
		});
		return { text: out, empty: any && empty };
	}

	function action_button(x, dt, card, page) {
		const b = make("button", "btn btn-xs" + (x.style === "Primary" ? "" : " btn-default"));
		b.textContent = __(x.label);
		if (x.style === "Primary") {
			["background", "border-color"].forEach((p) => b.style.setProperty(p, "var(--blue-500, #2490ef)", "important"));
			b.style.setProperty("color", "#fff", "important");
			b.style.setProperty("font-weight", "600", "important");
		}
		["pointerdown", "mousedown", "touchstart"].forEach((ev) => b.addEventListener(ev, (e) => e.stopPropagation()));
		b.addEventListener("click", (e) => {
			e.stopPropagation();
			e.preventDefault();
			const refresh = () => {
				delete (cache[dt] || {})[card.name];
				if (page && page.board && page.board.refresh) page.board.refresh();
				else if (window.cur_list && window.cur_list.refresh) window.cur_list.refresh();
			};
			const ctx = { doctype: dt, name: card.name, frm: null, refresh };
			if (window.nexlify && nexlify.board && nexlify.board.run_action) nexlify.board.run_action(x.action, ctx);
			else if (window.nx_run_action) window.nx_run_action(x.action, ctx);
		});
		return b;
	}

	function ensure_tone_css() {
		if (document.getElementById("nx-step-css")) return;
		const dark = (sel) => `[data-theme="dark"] ${sel}, [data-theme-mode="dark"] ${sel}`;
		const style = document.createElement("style");
		style.id = "nx-step-css";
		style.textContent = `
			.nx-tone-Warning { background: rgba(245,159,0,.14); color: #a35f00; }
			.nx-tone-Pending { background: rgba(234,179,8,.16); color: #8a5a00; }
			.nx-tone-Info { background: rgba(36,144,239,.12); color: #1a6fc4; }
			.nx-tone-Success { background: rgba(47,158,68,.13); color: #2b7a3b; }
			.nx-tone-Neutral { background: rgba(128,128,128,.12); color: var(--text-muted); }
			${dark(".nx-tone-Warning")} { background: rgba(245,159,0,.20); color: #ffc46b; }
			${dark(".nx-tone-Pending")} { background: rgba(234,179,8,.20); color: #fde047; }
			${dark(".nx-tone-Info")} { background: rgba(36,144,239,.20); color: #8cc8ff; }
			${dark(".nx-tone-Success")} { background: rgba(47,158,68,.20); color: #7ee2a0; }
			${dark(".nx-tone-Neutral")} { background: rgba(160,160,160,.16); color: #c9cdd2; }
		`;
		document.head.appendChild(style);
	}

	function stage_abbr(stage, map) {
		if (map[stage]) return map[stage];
		const words = String(__(stage)).replace(/[^\p{L}\p{N}\s]/gu, " ").split(/\s+/).filter(Boolean);
		if (words.length > 1) return words.map((w) => w[0]).join("").toUpperCase().slice(0, 4);
		return (words[0] || "").slice(0, 3).toUpperCase();
	}

	function stage_path(page, current, hist, layout) {
		const short_map = color_map((layout && layout.stage_labels) || "");
		const cols = ((page.board_doc && page.board_doc.columns) || [])
			.filter((c) => c.status !== "Archived").map((c) => c.column_name);
		const ci = cols.indexOf(current);
		if (!cols.length || ci < 0) return null;
		const entered = {};
		const visited = new Set();
		let backs = 0;
		hist.forEach((h, i) => {
			if (!h.stage) return;
			entered[h.stage] = h.on;
			visited.add(h.stage);
			if (i > 0 && hist[i - 1].stage && cols.indexOf(h.stage) < cols.indexOf(hist[i - 1].stage)) backs++;
		});
		const wrap = make("div", "nx-card-path", "margin:8px 0 2px");
		const grid = make("div", "", `display:grid;grid-template-columns:repeat(${cols.length},minmax(0,1fr));gap:4px`);
		const rows = [];
		cols.forEach((c, i) => {
			const state = c === current ? "now" : i < ci ? "done" : visited.has(c) ? "back" : "todo";
			const color = { done: TONE.green, now: "var(--blue-500, #2490ef)", back: TONE.orange,
				todo: "var(--surface-gray-3, rgba(128,128,128,.25))" }[state];
			const when = entered[c] ? frappe.datetime.str_to_user(String(entered[c]).slice(0, 10)) : null;
			const cell = make("div", "", "min-width:0");
			const bar = make("div", "", `height:5px;border-radius:999px;background:${color}`);
			const lab = make("div", "", `font-size:10px;letter-spacing:.05em;line-height:1.2;margin-bottom:3px;text-align:center;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;`
				+ `color:${state === "now" ? "var(--blue-500, #2490ef)" : state === "todo" ? MUTED : STRONG};font-weight:${state === "now" ? 600 : 400}`);
			lab.textContent = stage_abbr(c, short_map);
			const tip = `${__(c)}${when ? " · " + when : state === "todo" ? " · " + __("not yet") : ""}`;
			try {
				frappe.ui.tooltip(cell, { text: tip });
			} catch (e) {
				cell.title = tip;
			}
			cell.append(lab, bar);
			grid.appendChild(cell);
			rows.push({ c, state, when, tip });
		});

		const icon = { done: ["✓", TONE.green], now: ["●", "var(--blue-500, #2490ef)"], back: ["↩", TONE.orange], todo: ["○", MUTED] };
		const list = make("div", "", `display:none;margin-top:8px;padding-top:8px;border-top:1px dashed ${LINE};font-size:12px`);
		list.innerHTML = rows.map((r) => `<div style="display:flex;align-items:center;gap:8px;padding:2px 0">
				<span style="width:14px;text-align:center;color:${icon[r.state][1]}">${icon[r.state][0]}</span>
				<span style="flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${r.state === "now" ? "font-weight:600;" : ""}${r.state === "todo" ? `color:${MUTED};` : ""}">${esc(__(r.c))}</span>
				<span style="color:${MUTED};font-size:11px;white-space:nowrap">${r.when || ""}</span></div>`).join("");

		const toggle = make("a", "", "cursor:pointer;color:var(--blue-500, #2490ef);white-space:nowrap");
		toggle.textContent = __("Details");
		["pointerdown", "mousedown", "touchstart"].forEach((ev) => toggle.addEventListener(ev, (e) => e.stopPropagation()));
		toggle.addEventListener("click", (e) => {
			e.stopPropagation();
			e.preventDefault();
			const open = list.style.display === "none";
			list.style.display = open ? "block" : "none";
			toggle.textContent = open ? __("Hide") : __("Details");
		});

		const cap = make("div", "", `display:flex;justify-content:space-between;align-items:center;gap:8px;font-size:11px;color:${MUTED};margin-top:6px`);
		const l = make("span");
		l.innerHTML = `<span style="color:var(--blue-500, #2490ef);font-weight:600">${esc(__(current))}</span> · ${ci + 1}/${cols.length}${backs ? ` · <span style="color:${TONE.orange}" title="${esc(__("Sent back {0} times", [backs]))}">↩${backs}</span>` : ""}`;
		const r = make("span", "", "display:flex;align-items:center;gap:6px;white-space:nowrap");
		if (entered[current]) r.append(document.createTextNode(__("{0} in stage", [frappe.datetime.prettyDate(entered[current], true)]) + " ·"));
		r.append(toggle);
		cap.append(l, r);

		let track = grid;
		if ((layout && layout.path_style) !== "Bars") {
			track = make("div", "", "padding:0 2px");
			const GRAY = "var(--surface-gray-3, rgba(128,128,128,.3))";
			const COL = { done: TONE.green, now: "var(--blue-500, #2490ef)", back: TONE.orange, todo: GRAY };
			const line = make("div", "", "display:flex;align-items:center");
			const labs = make("div", "", "position:relative;height:14px;margin-top:4px");
			const n = rows.length;
			rows.forEach((r, i) => {
				const col = COL[r.state];
				const dot = make("span", "", r.state === "now"
					? `width:12px;height:12px;border-radius:50%;border:2px solid ${col};box-sizing:border-box;flex:none`
					: `width:9px;height:9px;border-radius:50%;background:${col};flex:none`);
				try {
					frappe.ui.tooltip(dot, { text: r.tip });
				} catch (e) {
					dot.title = r.tip;
				}
				line.appendChild(dot);
				if (i < n - 1) {
					const ns = rows[i + 1].state;
					line.appendChild(make("i", "", `flex:1;height:2px;background:${ns === "todo" ? GRAY : ns === "back" ? TONE.orange : TONE.green}`));
				}
				const l = make("span", "", `position:absolute;top:0;font-size:10px;letter-spacing:.04em;white-space:nowrap;`
					+ `left:${n > 1 ? (i / (n - 1)) * 100 : 0}%;transform:${i === 0 ? "none" : i === n - 1 ? "translateX(-100%)" : "translateX(-50%)"};`
					+ `color:${r.state === "now" ? "var(--blue-500, #2490ef)" : r.state === "todo" ? MUTED : STRONG};font-weight:${r.state === "now" ? 600 : 400}`);
				l.textContent = stage_abbr(r.c, short_map);
				labs.appendChild(l);
			});
			track.append(line, labs);
		}
		wrap.append(track, cap, list);
		return wrap;
	}

	function paint(dt, layout, card, el, body, page, doc, hist) {
		body.innerHTML = "";
		el.querySelectorAll(".nx-card-added").forEach((n) => n.remove());
		if (layout.hero_field && doc[layout.hero_field] !== undefined && doc[layout.hero_field] !== null
			&& (flt(doc[layout.hero_field]) || (layout.hero_target && flt(doc[layout.hero_target])))) {
			const hdf = df_of(dt, layout.hero_field);
			const hv = flt(doc[layout.hero_field]);
			const { text, full } = number_text(hv, hdf, doc, true);
			const tv = layout.hero_target ? flt(doc[layout.hero_target]) : 0;
			let chip = "";
			if (tv > 0) {
				const pct = (hv / tv) * 100;
				const tone = pct >= 99.995 ? TONE.green : pct >= 80 ? TONE.orange : TONE.red;
				chip = `<span style="font-size:11px;color:${tone};font-weight:600">${Math.round(pct)}% ${esc(__(layout.hero_target_label || "of target"))}</span>`;
			}
			const hero = make("div", "", "margin:8px 0 2px");
			const rule_badges = (layout.rules || []).filter((r) => r.badge && test(r.condition, doc));
			hero.innerHTML = hv
				? `<div class="nx-hero-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
					<span style="font-size:20px;font-weight:700;color:${STRONG}" title="${esc(full)}">${esc(text)}</span>${chip}</div>`
				: `<div class="nx-hero-row" style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">
					<span style="font-size:14px;color:${MUTED}">${esc(__("Not priced yet"))}</span></div>`;
			const hrow = hero.querySelector(".nx-hero-row");
			rule_badges.forEach((r) => hrow.appendChild(badge({ label: __(r.badge), theme: r.badge_theme || "gray" })));
			if (layout.hero_note) {
				const n = fill(layout.hero_note, dt, doc);
				if (!n.empty && n.text.trim()) hero.innerHTML += `<div style="font-size:12px;color:${MUTED};margin-top:2px">${esc(n.text)}</div>`;
			}
			body.appendChild(hero);
		}
		if (hist && page && page.field_name) {
			const path = stage_path(page, doc[page.field_name], hist, layout);
			if (path) body.appendChild(path);
		}
		let step_action = null;
		const step = (layout.next_steps || []).find((x) => x.text && test(x.condition, doc));
		if (step) {
			ensure_tone_css();
			const tone = ["Warning", "Pending", "Info", "Success", "Neutral"].includes(step.tone) ? step.tone : "Warning";
			const fg = "currentColor";
			const box = make("div", `nx-step nx-tone-${tone}`, "border-radius:8px;padding:8px 10px;margin-top:10px");
			box.innerHTML = `<div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:${fg}">${step.tone === "Pending" ? `${frappe.utils.icon("clock", "xs")} ${esc(__("Pending"))}` : esc(__("Next step"))}</div>
				<div style="font-weight:600;color:${fg};margin-top:2px">${esc(fill(__(step.text), dt, doc).text)}</div>`;
			if (step.button_label && step.action) {
				step_action = step.action;
				const b = action_button({ label: step.button_label, action: step.action, style: "Primary" }, dt, card, page);
				b.style.width = "100%";
				b.style.marginTop = "8px";
				box.appendChild(b);
			}
			body.appendChild(box);
		}
		const checks = (layout.checklist || []).filter((x) => x.label && test(x.only_when, doc));
		if (checks.length) {
			const g = make("div", "", `display:grid;grid-template-columns:1fr 1fr;gap:4px 12px;margin-top:10px;font-size:12px;color:${MUTED}`);
			checks.forEach((x) => {
				const ok = x.done_when ? test(x.done_when, doc) : false;
				const it = make("div", "", "display:flex;align-items:center;gap:6px;min-width:0");
				it.innerHTML = `<span style="color:${ok ? TONE.green : MUTED}">${ok ? "✓" : "○"}</span>
					<span style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;${ok ? `color:${STRONG}` : ""}">${esc(fill(__(x.label), dt, doc).text)}</span>`;
				g.appendChild(it);
			});
			body.appendChild(g);
		}

		const title_row = el.querySelector(".kn-title-row");
		const t = title_row && title_row.querySelector(".kn-card-title");
		if (t && layout.title_field && doc[layout.title_field]) t.textContent = doc[layout.title_field];
		if (t && cint(layout.show_name) && t.textContent !== card.name) {
			const n = make("div", "nx-card-added",
				`font-size:11px;color:${MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis;margin-top:1px`);
			n.textContent = card.name;
			n.title = card.name;
			title_row.insertAdjacentElement("afterend", n);
		}

		const rules = (layout.rules || []).filter((r) => test(r.condition, doc));
		const stripe = rules.find((r) => r.color);
		el.style.borderLeft = stripe ? `3px solid ${stripe.color}` : card.color ? `3px solid ${card.color}` : "";

		const lines = make("div", "", "display:flex;flex-direction:column;gap:2px");
		const badges = make("div", "", "display:flex;flex-wrap:wrap;gap:4px");
		const numbers = make("div", "", "display:grid;grid-template-columns:repeat(auto-fit,minmax(88px,1fr));gap:6px 12px");
		const bottom = [];
		if (!layout.hero_field) rules.filter((r) => r.badge).forEach((r) => badges.appendChild(badge({ label: __(r.badge), theme: r.badge_theme || "gray" })));

		const compact = cint(layout.compact_numbers);
		(layout.fields || []).forEach((f) => {
			const v = doc[f.fieldname];
			if (v === null || v === undefined || v === "" || !test(f.condition, doc)) return;
			const df = df_of(dt, f.fieldname);
			const label = __(f.label || df.label || f.fieldname);
			if (f.show_as === "Badge") {
				badges.appendChild(badge({ label: __(v), theme: color_map(f.badge_colors)[v] || "gray" }));
			} else if (f.show_as === "Number") {
				const { text, full } = number_text(v, df, doc, compact);
				const n = make("div", "", "min-width:0");
				n.innerHTML = `<div style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">${esc(label)}</div>
					<div style="font-size:14px;font-weight:600;color:${STRONG};white-space:nowrap">${esc(text)}</div>`;
				n.title = `${label}: ${full}`;
				numbers.appendChild(n);
			} else if (f.show_as === "Date") {
				bottom.push(date_badge(v, label));
			} else if (f.show_as === "User") {
				bottom.push(user_avatar(page, v, label));
			} else {
				const s = make("div", "", `font-size:12px;color:${MUTED};white-space:nowrap;overflow:hidden;text-overflow:ellipsis`);
				const html = frappe.format(v, df, { inline: true }, doc);
				s.innerHTML = f.show_as === "Subtitle" ? html : `${esc(label)}: <span style="color:${STRONG}">${html}</span>`;
				lines.appendChild(s);
			}
		});

		const top = make("div", "", "display:flex;flex-direction:column;gap:6px");
		if (lines.childNodes.length) top.appendChild(lines);
		if (badges.childNodes.length) top.appendChild(badges);
		if (top.childNodes.length) body.appendChild(top);

		const metrics = make("div", "", `display:flex;flex-direction:column;gap:8px;margin-top:10px;padding-top:10px;border-top:1px solid ${LINE}`);
		if (numbers.childNodes.length) metrics.appendChild(numbers);
		const pv = layout.progress_value;
		const pt = layout.progress_target;
		if (pv && pt && flt(doc[pt]) > 0 && layout.progress_title && test(layout.progress_condition, doc)) {
			const v = flt(doc[pv]);
			const t = flt(doc[pt]);
			const sec = layout.progress_secondary ? Math.min(flt(doc[layout.progress_secondary]), v) : 0;
			const pct = (v / t) * 100;
			const w = (x) => Math.max(0, Math.min((x / t) * 100, 100));
			const dfv = df_of(dt, pv);
			const fmt = (x) => number_text(x, dfv, doc, cint(layout.compact_numbers)).text;
			const box = make("div", "", `padding:10px;border:1px solid ${LINE};border-radius:8px`);
			box.innerHTML = `
				<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px">
					<span style="font-size:10px;letter-spacing:.06em;text-transform:uppercase;color:${MUTED}">${esc(__(layout.progress_title))}</span>
					<span style="font-size:11px;font-weight:600;color:${pct >= 99.995 ? TONE.green : MUTED}">${Math.round(pct)}%</span></div>
				<div style="display:flex;justify-content:space-between;align-items:baseline;gap:8px;margin-top:4px">
					<span style="white-space:nowrap"><b style="font-size:14px;color:${STRONG}" title="${esc(number_text(v, dfv, doc, false).full)}">${esc(fmt(v))}</b>
						<span style="font-size:11px;color:${MUTED}">${esc(__(layout.progress_label || "done"))}</span></span>
					<span style="white-space:nowrap"><b style="font-size:14px;color:${t - v > 0.005 ? STRONG : TONE.green}">${esc(fmt(Math.max(t - v, 0)))}</b>
						<span style="font-size:11px;color:${MUTED}">${esc(__("left"))}</span></span></div>
				<div style="height:6px;border-radius:999px;background:var(--surface-gray-3, rgba(128,128,128,.2));overflow:hidden;display:flex;margin-top:6px">
					<i style="display:block;height:100%;width:${w(sec)}%;background:${TONE.green}"></i>
					<i style="display:block;height:100%;width:${Math.max(w(v) - w(sec), 0)}%;background:var(--blue-500, #2490ef)"></i></div>
				${layout.progress_secondary ? `<div style="font-size:11px;color:${MUTED};margin-top:4px">${esc(fmt(sec))} ${esc(__(layout.progress_secondary_label || "collected"))}</div>` : ""}`;
			metrics.appendChild(box);
		} else if (pv && pt && flt(doc[pt]) > 0 && !layout.progress_title && test(layout.progress_condition, doc)) {
			const pct = (flt(doc[pv]) / flt(doc[pt])) * 100;
			const tone = pct >= 100 ? TONE.green : pct >= 80 ? TONE.orange : TONE.red;
			const p = make("div");
			p.innerHTML = `<div style="height:4px;border-radius:999px;background:var(--surface-gray-3, rgba(128,128,128,.2));overflow:hidden">
					<div style="height:100%;width:${Math.max(0, Math.min(pct, 100))}%;background:${tone};border-radius:999px"></div></div>
				<div style="font-size:11px;color:${MUTED};margin-top:4px;text-align:right">${Math.round(pct)}% ${esc(__(layout.progress_label || "of target"))}</div>`;
			metrics.appendChild(p);
		}
		if (metrics.childNodes.length) body.appendChild(metrics);

		const acts = (layout.actions || []).filter((x) => x.label && x.action && test(x.condition, doc)
			&& !(cint(layout.dedupe_actions) && step_action && x.action === step_action));
		if (acts.length) {
			const row = make("div", "nx-card-actions", "display:flex;flex-wrap:wrap;gap:6px;margin-top:10px");
			acts.forEach((x) => {
				const b = make("button", "btn btn-xs" + (x.style === "Primary" ? "" : " btn-default"));
				b.textContent = __(x.label);
				b.style.cssText += "padding:2px 10px;font-size:11px;line-height:1.6;";
				if (x.style === "Primary") {
					["background", "border-color"].forEach((p) => b.style.setProperty(p, "var(--blue-500, #2490ef)", "important"));
					b.style.setProperty("color", "#fff", "important");
					b.style.setProperty("font-weight", "600", "important");
				}
				const stop = (e) => e.stopPropagation();
				["pointerdown", "mousedown", "touchstart"].forEach((ev) => b.addEventListener(ev, stop));
				b.addEventListener("click", (e) => {
					e.stopPropagation();
					e.preventDefault();
					const refresh = () => {
						delete (cache[dt] || {})[card.name];
						if (page && page.board && page.board.refresh) page.board.refresh();
						else if (window.cur_list && window.cur_list.refresh) window.cur_list.refresh();
					};
					const ctx = { doctype: dt, name: card.name, frm: null, refresh };
					if (window.nexlify && nexlify.board && nexlify.board.run_action) nexlify.board.run_action(x.action, ctx);
					else if (window.nx_run_action) window.nx_run_action(x.action, ctx);
				});
				row.appendChild(b);
			});
			body.appendChild(row);
		}

		if (bottom.length) {
			const foot = el.querySelector(":scope > div.mt-3");
			let holder = foot && foot.querySelector(":scope > .inline-flex");
			if (foot && !holder) {
				holder = make("div", "inline-flex items-center gap-2 min-w-0");
				foot.prepend(holder);
			}
			if (!holder) {
				holder = make("div", "", "display:flex;align-items:center;gap:8px;margin-top:10px");
				body.appendChild(holder);
			}
			bottom.forEach((b) => {
				b.classList.add("nx-card-added");
				holder.appendChild(b);
			});
		}
	}

	const live = {};
	function decorate(dt, layout, card, el, body, page, overlay) {
		(live[dt] = live[dt] || {})[card.name] = { layout, card, el, body, page };
		const ver = overlay ? "moved:" + Date.now() : card.modified;
		const field = page && page.field_name;
		const want = cint(layout.show_stage_path) && field;
		Promise.all([
			fetch_row(dt, layout, card.name, ver),
			want ? fetch_history(dt, field, card.name, ver) : Promise.resolve(null),
		]).then(([doc, hist]) => {
			if (!doc) return;
			try {
				const data = { ...doc, ...(overlay || {}) };
				live[dt][card.name].doc = data;
				live[dt][card.name].hist = hist;
				paint(dt, layout, card, el, body, page, data, hist);
			} catch (e) {
				console.error("Nexlify Board card", e);
			}
		});
	}
	function repaint_moved(dt, move) {
		(move.cardIds || [move.cardId]).forEach((n) => {
			const x = live[dt] && live[dt][n];
			if (!x) return;
			const field = x.page && x.page.field_name;
			const overlay = field ? { [field]: move.toColumn } : {};
			if (x.doc) {
				try {
					const now = { ...x.doc, ...overlay };
					x.doc = now;
					const h = x.hist && field ? [...x.hist, { stage: overlay[field], on: frappe.datetime.now_datetime() }] : x.hist;
					x.hist = h;
					paint(dt, x.layout, x.card, x.el, x.body, x.page, now, h);
				} catch (e) {
					console.error("Nexlify Board card", e);
				}
			}
			setTimeout(() => decorate(dt, x.layout, x.card, x.el, x.body, x.page, overlay), 700);
		});
	}

	function own_card(dt, layout, card, el, page) {
		const rows = make("div", "flex flex-col gap-1");
		rows.appendChild(page.title_row(card));
		el.appendChild(rows);
		const body = make("div", "nx-card-body", "margin-top:6px");
		el.appendChild(body);
		el.appendChild(page.card_footer(card));
		page.bind_context_menu(el, card);
		decorate(dt, layout, card, el, body, page);
	}

	// the same buttons at the top of the form: one alone, several under "Actions"
	const form_hooked = new Set();
	function form_actions(dt, layout) {
		if (form_hooked.has(dt)) return;
		form_hooked.add(dt);
		frappe.ui.form.on(dt, {
			refresh(frm) {
				setTimeout(() => {
					(frm.__nx_actions || []).forEach(([label, group]) => frm.remove_custom_button(label, group));
					frm.__nx_actions = [];
					if (!cint(layout.form_actions) || frm.is_new()) return;
					const doc = frm.doc;
					const list = [];
					const step = (layout.next_steps || []).find((x) => x.text && test(x.condition, doc));
					if (step && step.button_label && step.action) list.push({ label: step.button_label, action: step.action });
					(layout.actions || []).forEach((x) => x.label && x.action && test(x.condition, doc) && list.push(x));
					const seen = new Set();
					const items = list.filter((x) => {
						if (x.action === "form" || seen.has(x.action)) return false;
						seen.add(x.action);
						return !(frm.custom_buttons && frm.custom_buttons[__(x.label)]);
					});
					const ctx = { doctype: dt, name: doc.name, frm, refresh: () => frm.reload_doc() };
					const run = (x) =>
						window.nexlify && nexlify.board && nexlify.board.run_action
							? nexlify.board.run_action(x.action, ctx)
							: window.nx_run_action && window.nx_run_action(x.action, ctx);
					if (items.length === 1) {
						const b = frm.add_custom_button(__(items[0].label), () => run(items[0]));
						["background", "border-color"].forEach((p) => b[0].style.setProperty(p, "var(--blue-500, #2490ef)", "important"));
						b[0].style.setProperty("color", "#fff", "important");
						b[0].style.setProperty("font-weight", "600", "important");
						frm.__nx_actions.push([__(items[0].label)]);
					} else {
						items.forEach((x) => {
							frm.add_custom_button(__(x.label), () => run(x), __("Actions"));
							frm.__nx_actions.push([__(x.label), __("Actions")]);
						});
					}
				}, 350);
			},
		});
	}

	const registered = new Set();
	function register(dt, layout) {
		if (registered.has(dt)) return;
		registered.add(dt);
		form_actions(dt, layout);
		frappe.provide("frappe.kanban_v2.settings");
		const S = frappe.kanban_v2.settings;
		const wrap = (raw) => {
			raw = raw || {};
			if (raw.__nx_cards) return raw;
			const prev = raw.renderCard;
			const prev_after = (raw.callbacks || {}).onAfterCardMove;
			return {
				...raw,
				__nx_cards: true,
				callbacks: {
					...(raw.callbacks || {}),
					onAfterCardMove: (move) => {
						if (prev_after) prev_after(move);
						try {
							repaint_moved(dt, move);
						} catch (e) {
							console.error("Nexlify Board card", e);
						}
					},
				},
				renderCard: (card, el, ctx, page) => {
					try {
						if (cint(layout.replace_card)) {
							// scripts that add to the card (card_badges) still run: their "default card" is ours
							const pg = Object.create(page);
							pg.render_card = (c, e) => own_card(dt, layout, c, e, page);
							prev ? prev(card, el, ctx, pg) : own_card(dt, layout, card, el, page);
						} else {
							prev ? prev(card, el, ctx, page) : page.render_card(card, el);
							el.querySelectorAll(":scope > .nx-card-body").forEach((n) => n.remove());
							const body = make("div", "nx-card-body", "margin-top:6px");
							el.appendChild(body);
							decorate(dt, layout, card, el, body, page);
						}
					} catch (e) {
						console.error("Nexlify Board card", e);
						if (!el.childNodes.length) page.render_card(card, el);
					}
				},
			};
		};
		let value = wrap(S[dt]);
		Object.defineProperty(S, dt, {
			configurable: true,
			enumerable: true,
			get: () => value,
			set: (v) => {
				value = wrap(v);
			},
		});
	}

	const start = (layouts) => Object.entries(layouts || {}).forEach(([dt, l]) => register(dt, l));
	const boot_layouts = frappe.boot && frappe.boot.nx_card_layouts;
	if (boot_layouts) start(boot_layouts);
	else frappe.xcall("nexlify_board.board_cards.get_layouts").then(start).catch(() => {});
})();
