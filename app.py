import streamlit as st
import pandas as pd
import plotly.graph_objects as go
import json
import time
import calendar as _cal
from datetime import date
from pathlib import Path
from dotenv import load_dotenv

load_dotenv(override=True)

CACHE_DIR = Path("cache")
CACHE_DIR.mkdir(exist_ok=True)
FETCH_STAMP = CACHE_DIR / "last_fetch.json"
CACHE_TTL = 3600

def _stamp_age():
    try:
        ts = json.loads(FETCH_STAMP.read_text())["ts"]
        return time.time() - ts
    except Exception:
        return None

def _save_stamp():
    FETCH_STAMP.write_text(json.dumps({"ts": time.time()}))

from src.apis import stackadapt, nexd, dv360, xandr, amazon_dsp
from src.apis.sheets import fetch_campaign_journey, extract_token_from_line
from src.utils.date_utils import get_mtd_dates, fmt
from src.utils.currency import get_usd_to_brl, to_brl

def to_brl_smart(spend, currency):
    return spend if currency == "BRL" else to_brl(spend)

def fmt_brl(v):
    return f"R$ {v:,.2f}"

st.set_page_config(
    page_title="Cost Dashboard",
    page_icon="📊",
    layout="wide",
    initial_sidebar_state="expanded",
)

st.markdown(
    '<link href="https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&display=swap" rel="stylesheet">',
    unsafe_allow_html=True,
)

st.markdown("""<style>
html,body,[data-testid="stAppViewContainer"],[data-testid="stMain"],section[data-testid="stMain"]>div{background:#030712!important;font-family:'Inter',sans-serif!important;color:#f9fafb!important}
*{font-family:'Inter',sans-serif!important}
[data-testid="stHeader"]{background:#030712!important;border-bottom:1px solid #0d1117}
[data-testid="stSidebar"]{background:#0d1117!important;border-right:1px solid #1f2937!important;min-width:220px!important;max-width:220px!important}
[data-testid="stSidebar"] [data-testid="stMarkdown"] p{color:#6b7280;font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;padding:1rem 1rem 0.4rem 1rem;margin:0}
[data-testid="stSidebarUserContent"]{padding:0!important}
section[data-testid="stSidebar"] > div{padding:0!important}
[data-testid="stSidebar"] [data-testid="stRadio"] > label{display:none}
[data-testid="stSidebar"] [data-testid="stRadio"] > div{gap:0!important}
[data-testid="stSidebar"] [data-testid="stRadio"] label{display:flex!important;align-items:center!important;padding:0.55rem 1rem!important;border-radius:0!important;color:#6b7280!important;font-size:0.85rem!important;font-weight:500!important;cursor:pointer!important;transition:all 0.15s!important;border-left:2px solid transparent!important;margin:0!important;width:100%!important}
[data-testid="stSidebar"] [data-testid="stRadio"] label:hover{color:#d1d5db!important;background:rgba(255,255,255,0.03)!important}
[data-testid="stSidebar"] [data-testid="stRadio"] label[data-baseweb="radio"] span:first-child{display:none!important}
[data-testid="stSidebar"] [data-testid="stRadio"] [aria-checked="true"]{color:#f9fafb!important;border-left:2px solid #3b82f6!important;background:rgba(59,130,246,0.08)!important}
::-webkit-scrollbar{width:5px;height:5px}
::-webkit-scrollbar-track{background:#030712}
::-webkit-scrollbar-thumb{background:#1f2937;border-radius:9999px}
[data-testid="stVerticalBlockBorderWrapper"]>div{background:#0d1117!important;border-color:#1f2937!important;border-radius:12px!important}
[data-testid="stDivider"] hr,hr{border-color:#1f2937!important;margin:1.25rem 0!important}
[data-testid="stCaptionContainer"] p{color:#4b5563!important;font-size:0.72rem!important}
[data-testid="stButton"] button{background:#0d1117!important;border:1px solid #1f2937!important;color:#6b7280!important;font-size:0.8rem!important;font-weight:500!important;border-radius:8px!important;padding:0.4rem 1rem!important;transition:all 0.15s!important}
[data-testid="stButton"] button:hover{border-color:#374151!important;color:#f9fafb!important}
[data-testid="stMultiSelect"]>div,[data-testid="stMultiSelect"] div[data-baseweb="select"]>div{background:#0d1117!important;border-color:#1f2937!important;border-radius:8px!important;color:#d1d5db!important}
[data-testid="stMultiSelect"] span[data-baseweb="tag"]{background:#1f2937!important;color:#d1d5db!important}
.card{background:#0d1117;border:1px solid #1f2937;border-radius:12px;padding:1.25rem 1.5rem;transition:border-color 0.2s}
.card:hover{border-color:#374151}
.card-label{font-size:0.7rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#4b5563;margin:0 0 0.4rem 0}
.card-value{font-size:1.75rem;font-weight:700;color:#fff;line-height:1.1;margin:0 0 0.3rem 0}
.card-sub{font-size:0.73rem;color:#4b5563;margin:0}
.card-badge{display:inline-block;font-size:0.67rem;font-weight:600;padding:0.15rem 0.5rem;border-radius:9999px;margin-bottom:0.4rem}
.badge-blue{background:rgba(59,130,246,0.1);color:#60a5fa;border:1px solid rgba(59,130,246,0.2)}
.badge-green{background:rgba(34,197,94,0.1);color:#4ade80;border:1px solid rgba(34,197,94,0.2)}
.badge-amber{background:rgba(245,158,11,0.1);color:#fbbf24;border:1px solid rgba(245,158,11,0.2)}
.badge-violet{background:rgba(139,92,246,0.1);color:#a78bfa;border:1px solid rgba(139,92,246,0.2)}
.badge-orange{background:rgba(249,115,22,0.1);color:#fb923c;border:1px solid rgba(249,115,22,0.2)}
.badge-red{background:rgba(239,68,68,0.1);color:#f87171;border:1px solid rgba(239,68,68,0.2)}
.badge-gray{background:rgba(107,114,128,0.1);color:#6b7280;border:1px solid rgba(107,114,128,0.2)}
.sec-label{font-size:0.68rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#4b5563;margin:0 0 0.2rem 0}
.sec-title{font-size:1rem;font-weight:600;color:#f9fafb;margin:0 0 0.2rem 0}
.sec-sub{font-size:0.75rem;color:#4b5563;margin:0 0 1rem 0}
</style>""", unsafe_allow_html=True)

# ── Constants ─────────────────────────────────────────────────────────────────
NEXD_CPM_BRL = 0.0014
PLATFORM_COLORS = {
    "StackAdapt": "#3b82f6",
    "DV360":      "#8b5cf6",
    "Xandr":      "#f59e0b",
    "Amazon DSP": "#22c55e",
    "Nexd":       "#f97316",
}
PLATFORM_BADGE = {
    "StackAdapt": "badge-blue",
    "DV360":      "badge-violet",
    "Xandr":      "badge-amber",
    "Amazon DSP": "badge-green",
    "Nexd":       "badge-orange",
}
PLATFORMS = {
    "StackAdapt": stackadapt,
    "DV360":      dv360,
    "Xandr":      xandr,
    "Amazon DSP": amazon_dsp,
}

# ── Data loading ──────────────────────────────────────────────────────────────
@st.cache_data(ttl=CACHE_TTL, show_spinner=False)
def load_all(start_str, end_str):
    s, e = date.fromisoformat(start_str), date.fromisoformat(end_str)
    out = {}
    for name, module in PLATFORMS.items():
        out[name] = module.fetch_mtd_cost(s, e)
    _save_stamp()
    return out

@st.cache_data(ttl=3600, show_spinner=False)
def load_exchange_rate():
    return get_usd_to_brl()

@st.cache_data(ttl=3600, show_spinner=False)
def load_campaign_journey():
    return fetch_campaign_journey()

@st.cache_data(ttl=3600, show_spinner=False)
def load_nexd(start_str, end_str):
    s, e = date.fromisoformat(start_str), date.fromisoformat(end_str)
    return nexd.fetch_mtd_impressions(s, e)

_age = _stamp_age()
if _age is None or _age >= CACHE_TTL:
    st.cache_data.clear()

start, end = get_mtd_dates()
_last_day = _cal.monthrange(start.year, start.month)[1]
month_end = start.replace(day=_last_day)

with st.spinner(""):
    results   = load_all(fmt(start), fmt(end))
    rate      = load_exchange_rate()
    journey   = load_campaign_journey()
    nexd_data = load_nexd(fmt(start), fmt(end))

# ── Pre-compute ───────────────────────────────────────────────────────────────
all_campaigns = {c["token"]: c for c in journey.get("data", [])}

platform_spend_by_token: dict[str, dict[str, float]] = {}
for _pname, _pdata in results.items():
    if _pdata["status"] != "ok":
        continue
    platform_spend_by_token[_pname] = {}
    for _line in _pdata.get("lines", []):
        _tok = extract_token_from_line(_line["name"])
        if _tok:
            _brl = to_brl_smart(_line["spend"], _pdata["currency"])
            platform_spend_by_token[_pname][_tok] = \
                platform_spend_by_token[_pname].get(_tok, 0.0) + _brl

active_platforms = list(platform_spend_by_token.keys())

# KPI totals
total_brl = sum(to_brl_smart(v["spend"], v["currency"]) for v in results.values() if v["status"] == "ok")
nexd_cost_brl = nexd_data["impressions"] * NEXD_CPM_BRL if nexd_data["status"] == "ok" else 0.0
total_brl += nexd_cost_brl

# ── Helpers ───────────────────────────────────────────────────────────────────
def _card(label, value, sub="", badge="", badge_cls="badge-gray"):
    b = f'<span class="card-badge {badge_cls}">{badge}</span><br>' if badge else ""
    return f'<div class="card">{b}<p class="card-label">{label}</p><p class="card-value">{value}</p><p class="card-sub">{sub}</p></div>'

def _card_empty(label, msg):
    return f'<div class="card"><p class="card-label">{label}</p><p class="card-value" style="color:#1f2937;font-size:1.4rem">—</p><p class="card-sub" style="color:#374151">{msg}</p></div>'

def _table_style(df):
    """Apply dark theme to a dataframe via Styler."""
    return df.style.set_properties(**{
        "background-color": "#0d1117",
        "color": "#d1d5db",
        "border-color": "#1f2937",
    }).set_table_styles([
        {"selector": "th", "props": [
            ("background-color", "#111827"),
            ("color", "#6b7280"),
            ("font-size", "0.7rem"),
            ("font-weight", "600"),
            ("text-transform", "uppercase"),
            ("letter-spacing", "0.06em"),
            ("border-bottom", "1px solid #1f2937"),
        ]},
        {"selector": "tr:hover td", "props": [("background-color", "#111827")]},
        {"selector": "td", "props": [("border-bottom", "1px solid #111827")]},
    ])

CHART_BG = "rgba(0,0,0,0)"
AXIS = dict(gridcolor="#1f2937", tickfont=dict(color="#4b5563", size=11), linecolor="#1f2937")

# ── Sidebar ───────────────────────────────────────────────────────────────────
platform_tab_names = [p for p in PLATFORMS if results[p]["status"] == "ok" and results[p]["spend"] > 0]
if nexd_data["status"] == "ok":
    platform_tab_names.append("Nexd")

nav_options = ["Dashboard"] + platform_tab_names + ["⚠️ Atenção"]

with st.sidebar:
    st.markdown(f"""
<div style="padding:1.25rem 1rem 0.75rem 1rem;border-bottom:1px solid #1f2937">
  <p style="font-size:0.95rem;font-weight:700;color:#f9fafb;margin:0 0 0.15rem 0">Cost Dashboard</p>
  <p style="font-size:0.7rem;color:#4b5563;margin:0">MTD · {fmt(start)} → {fmt(end)}</p>
</div>
""", unsafe_allow_html=True)

    st.markdown("<p style='padding:1rem 1rem 0.3rem 1rem;font-size:0.65rem;font-weight:600;text-transform:uppercase;letter-spacing:0.1em;color:#374151;margin:0'>Navegação</p>", unsafe_allow_html=True)
    active_page = st.radio("nav", nav_options, label_visibility="collapsed")

    st.markdown("<div style='position:absolute;bottom:1rem;left:0;right:0;padding:0 1rem'>", unsafe_allow_html=True)
    if st.button("↻  Atualizar dados", use_container_width=True):
        st.cache_data.clear()
        FETCH_STAMP.unlink(missing_ok=True)
        st.rerun()
    age = _stamp_age()
    if age is not None:
        mins = int(age / 60)
        st.caption(f"Atualizado há {mins}min")
    st.markdown("</div>", unsafe_allow_html=True)

# ── Page header ───────────────────────────────────────────────────────────────
st.markdown(f'<p class="sec-label">Mídia Paga</p><p class="sec-title">{active_page}</p><p class="sec-sub">Month-to-Date · {fmt(start)} → {fmt(end)}</p>', unsafe_allow_html=True)
st.markdown("<div style='height:1rem'></div>", unsafe_allow_html=True)

# ═══════════════════════════════════════════════════════════════════════════════
# PAGE — DASHBOARD
# ═══════════════════════════════════════════════════════════════════════════════
if active_page == "Dashboard":
    # KPI cards
    cards = []
    for name in ["StackAdapt", "DV360", "Xandr", "Amazon DSP"]:
        d = results[name]
        if d["status"] == "ok":
            cards.append(_card(name, fmt_brl(to_brl_smart(d["spend"], d["currency"])),
                f"USD {d['spend']:,.2f}", badge="DSP", badge_cls=PLATFORM_BADGE[name]))
        elif d["status"] == "error":
            cards.append(_card_empty(name, d["message"]))
        # no_credentials: skip silently

    if nexd_data["status"] == "ok":
        _pct = nexd_data["impressions"] / nexd_data["cap"] * 100
        _cls = "badge-green" if _pct < 60 else "badge-amber" if _pct < 80 else "badge-red"
        cards.append(_card("Nexd", fmt_brl(nexd_cost_brl),
            f"{nexd_data['impressions']:,.0f} impressões",
            badge=f"{_pct:.1f}% do pacote", badge_cls=_cls))

    cards.append(_card("Total MTD", fmt_brl(total_brl),
        f"USD 1 = R$ {rate:.4f}", badge="Consolidado", badge_cls="badge-gray"))

    cols = st.columns(len(cards))
    for col, html in zip(cols, cards):
        col.markdown(html, unsafe_allow_html=True)

    st.markdown("<div style='height:1.5rem'></div>", unsafe_allow_html=True)

    # Charts
    ok_data = {k: v for k, v in results.items() if v["status"] == "ok" and v["spend"] > 0}
    if ok_data:
        spend_map = {k: to_brl_smart(v["spend"], v["currency"]) for k, v in ok_data.items()}
        if nexd_data["status"] == "ok":
            spend_map["Nexd"] = nexd_cost_brl
        df_sp = pd.DataFrame([{"Plataforma": k, "Gasto": v} for k, v in spend_map.items()]).sort_values("Gasto", ascending=True)

        col_bar, col_pie = st.columns(2, gap="large")
        with col_bar:
            st.markdown('<p class="sec-label" style="margin-bottom:0.6rem">Gasto por plataforma</p>', unsafe_allow_html=True)
            fig_bar = go.Figure(go.Bar(
                x=df_sp["Gasto"], y=df_sp["Plataforma"], orientation="h",
                marker_color=[PLATFORM_COLORS.get(p, "#6366f1") for p in df_sp["Plataforma"]],
                text=[f"R$ {v:,.0f}" for v in df_sp["Gasto"]],
                textposition="outside", textfont=dict(size=11, color="#6b7280"),
            ))
            fig_bar.update_layout(height=260, margin=dict(l=0, r=100, t=0, b=0),
                plot_bgcolor=CHART_BG, paper_bgcolor=CHART_BG,
                xaxis=dict(**AXIS, showgrid=True, tickprefix="R$", tickformat=",.0f"),
                yaxis=dict(**AXIS, showgrid=False), font=dict(family="Inter"))
            st.plotly_chart(fig_bar, use_container_width=True)

        with col_pie:
            st.markdown('<p class="sec-label" style="margin-bottom:0.6rem">Distribuição</p>', unsafe_allow_html=True)
            fig_pie = go.Figure(go.Pie(
                labels=df_sp["Plataforma"], values=df_sp["Gasto"],
                marker_colors=[PLATFORM_COLORS.get(p, "#6366f1") for p in df_sp["Plataforma"]],
                hole=0.6, textinfo="label+percent", textfont=dict(size=11),
            ))
            fig_pie.update_layout(height=260, showlegend=False, margin=dict(l=0, r=0, t=0, b=0),
                paper_bgcolor=CHART_BG, font=dict(family="Inter", color="#9ca3af"))
            st.plotly_chart(fig_pie, use_container_width=True)

        # Daily chart
        daily_data = {k: v["daily"] for k, v in ok_data.items() if v.get("daily")}
        if daily_data:
            st.divider()
            st.markdown('<p class="sec-label" style="margin-bottom:0.6rem">Custo dia a dia</p>', unsafe_allow_html=True)
            all_dates = sorted({d["date"] for s in daily_data.values() for d in s})
            fig_d = go.Figure()
            totals = {d: 0.0 for d in all_dates}
            for name, series in daily_data.items():
                dm = {d["date"]: to_brl_smart(d["spend"], ok_data[name]["currency"]) for d in series}
                y = [dm.get(d, 0.0) for d in all_dates]
                for d, v in zip(all_dates, y):
                    totals[d] += v
                fig_d.add_trace(go.Scatter(x=all_dates, y=y, mode="lines+markers", name=name,
                    line=dict(color=PLATFORM_COLORS.get(name, "#6366f1"), width=2),
                    marker=dict(size=4),
                    hovertemplate=f"<b>{name}</b><br>%{{x}}<br>R$ %{{y:,.2f}}<extra></extra>"))
            fig_d.add_trace(go.Scatter(x=all_dates, y=[totals[d] for d in all_dates],
                mode="lines+markers", name="Total",
                line=dict(color="#ffffff", width=2, dash="dot"), marker=dict(size=4),
                hovertemplate="<b>Total</b><br>%{x}<br>R$ %{y:,.2f}<extra></extra>"))
            fig_d.update_layout(height=300, margin=dict(l=0, r=0, t=0, b=0),
                plot_bgcolor=CHART_BG, paper_bgcolor=CHART_BG, hovermode="x unified",
                legend=dict(orientation="h", yanchor="bottom", y=1.02, xanchor="left", x=0,
                    font=dict(size=11, color="#6b7280"), bgcolor=CHART_BG),
                xaxis=dict(**AXIS, showgrid=False),
                yaxis=dict(**AXIS, tickprefix="R$ ", tickformat=",.0f"),
                font=dict(family="Inter"))
            st.plotly_chart(fig_d, use_container_width=True)

    # Campaign Journey
    st.divider()
    st.markdown('<p class="sec-label">Planilha</p><p class="sec-title">Campaign Journey</p><p class="sec-sub">Gasto MTD por token cruzado com a planilha</p>', unsafe_allow_html=True)

    if journey["status"] == "error":
        st.error(f"Erro ao ler planilha: {journey['message']}")
    elif not journey["data"]:
        st.info("Nenhuma campanha encontrada na planilha.")
    else:
        all_tokens_with_spend = set()
        for p in active_platforms:
            all_tokens_with_spend.update(platform_spend_by_token[p].keys())

        rows_j = []
        for token in all_tokens_with_spend:
            camp = all_campaigns.get(token)
            if not camp:
                continue
            s_c, e_c = camp.get("start"), camp.get("end")
            today = date.today()
            ativa = (s_c is None or s_c <= today) and (e_c is None or e_c >= today)
            row = {
                "Token":    token,
                "Cliente":  camp["cliente"],
                "Campanha": camp["campanha"],
                "Status":   "Ativa" if ativa else "Encerrada",
                "Investido": camp["investido"],
            }
            total_plat = 0.0
            for p in active_platforms:
                sp = platform_spend_by_token.get(p, {}).get(token, 0.0)
                row[p] = sp
                total_plat += sp
            if total_plat == 0:
                continue
            row["Total Plataformas"] = total_plat
            row["% Investido"] = (total_plat / camp["investido"] * 100) if camp["investido"] > 0 else 0.0
            rows_j.append(row)

        if rows_j:
            df_j = pd.DataFrame(rows_j).sort_values("Total Plataformas", ascending=False)
            clientes = sorted(df_j["Cliente"].unique())
            selected = st.multiselect("Filtrar por cliente", clientes, placeholder="Todos os clientes")
            df_d = df_j[df_j["Cliente"].isin(selected)].copy() if selected else df_j.copy()

            fmt_map = {"Investido": "R$ {:,.2f}", "Total Plataformas": "R$ {:,.2f}", "% Investido": "{:.1f}%"}
            for p in active_platforms:
                if p in df_d.columns:
                    fmt_map[p] = "R$ {:,.2f}"

            st.dataframe(
                _table_style(df_d).format(fmt_map, na_rep="—"),
                use_container_width=True, hide_index=True,
            )
            st.caption(f"{len(df_d)} campanhas com gasto MTD identificadas por token")
        else:
            st.info("Nenhum token com gasto MTD encontrado nas plataformas.")


# ═══════════════════════════════════════════════════════════════════════════════
# PAGE — PER PLATFORM
# ═══════════════════════════════════════════════════════════════════════════════
for pname in platform_tab_names:
    if active_page == pname:

        # ── Nexd (impressions-only platform) ──────────────────────────────────
        if pname == "Nexd":
            _nd = nexd_data
            impressions = _nd["impressions"]
            cap         = _nd["cap"]
            pct         = impressions / cap * 100
            bar_color   = "#ef4444" if pct >= 80 else "#f59e0b" if pct >= 60 else "#3b82f6"

            st.markdown(f'<p class="sec-label">Nexd</p><p class="sec-title">R$ {nexd_cost_brl:,.2f}</p><p class="sec-sub">{impressions:,.0f} impressões · {pct:.1f}% do pacote mensal</p>', unsafe_allow_html=True)

            col_g, col_c = st.columns([1, 2], gap="large")
            with col_g:
                fig_g = go.Figure(go.Indicator(
                    mode="gauge+number",
                    value=impressions,
                    number={"valueformat": ",.0f", "font": {"size": 22, "color": "#f9fafb"}},
                    title={"text": f"<span style='font-size:0.85em;color:#4b5563'>{pct:.1f}% do pacote</span>"},
                    gauge={
                        "axis": {"range": [0, cap], "tickformat": ".2s",
                                 "tickcolor": "#374151", "tickfont": {"color": "#4b5563", "size": 10}},
                        "bar": {"color": bar_color},
                        "bgcolor": "#111827", "bordercolor": "#1f2937",
                        "steps": [{"range": [0, cap], "color": "#111827"}],
                        "threshold": {"line": {"color": "#374151", "width": 2}, "thickness": 0.8, "value": cap},
                    },
                ))
                fig_g.update_layout(height=230, margin=dict(l=10, r=10, t=40, b=10),
                    paper_bgcolor=CHART_BG, font=dict(family="Inter", color="#d1d5db"))
                st.plotly_chart(fig_g, use_container_width=True)
                st.caption(f"Cap: {cap:,.0f} · Restam: {cap - impressions:,.0f}")

            with col_c:
                if _nd["campaigns"]:
                    df_nc = pd.DataFrame(_nd["campaigns"])
                    df_nc["% do Total"] = (df_nc["impressions"] / impressions * 100).round(1)
                    df_nc = df_nc.rename(columns={"name": "Campanha", "impressions": "Impressões"})
                    cols_show = [c for c in ["Campanha", "Impressões", "% do Total"] if c in df_nc.columns]
                    st.markdown("**Por campanha**")
                    st.dataframe(
                        _table_style(df_nc[cols_show]).format(
                            {"Impressões": "{:,.0f}", "% do Total": "{:.1f}%"}, na_rep="—"),
                        use_container_width=True, hide_index=True, height=220,
                    )

            if _nd.get("layouts"):
                df_lay = pd.DataFrame(_nd["layouts"])
                total_lay = df_lay["impressions"].sum()
                df_lay["% do Total"] = (df_lay["impressions"] / total_lay * 100).round(1)
                df_lay = df_lay.rename(columns={"layout": "Formato", "impressions": "Impressões"})
                lay_cols = [c for c in ["Formato", "Impressões", "% do Total"] if c in df_lay.columns]
                st.markdown("**Por formato**")
                st.dataframe(
                    _table_style(df_lay[lay_cols]).format(
                        {"Impressões": "{:,.0f}", "% do Total": "{:.1f}%"}, na_rep="—"),
                    use_container_width=True, hide_index=True,
                )
            continue

        # ── DSP platforms ──────────────────────────────────────────────────────
        pdata = results[pname]
        spend_brl = to_brl_smart(pdata["spend"], pdata["currency"])

        usd_sub = f"USD {pdata['spend']:,.2f}" if pdata["currency"] == "USD" else ""
        st.markdown(
            f'<p class="sec-label">{pname}</p>'
            f'<p class="sec-title">{fmt_brl(spend_brl)}</p>'
            f'<p class="sec-sub">{usd_sub}</p>',
            unsafe_allow_html=True,
        )

        lines = pdata.get("lines", [])
        if not lines:
            st.info("Nenhuma line com gasto encontrada.")
            continue

        rows_p = []
        for line in lines:
            token = extract_token_from_line(line["name"])
            brl   = to_brl_smart(line["spend"], pdata["currency"])
            camp  = all_campaigns.get(token) if token else None
            investido = camp["investido"] if camp else None
            pct_inv   = (brl / investido * 100) if (investido and investido > 0) else None
            rows_p.append({
                "Line":      line["name"],
                "Token":     token or "—",
                "Cliente":   camp["cliente"] if camp else "—",
                "Campanha":  camp["campanha"] if camp else "—",
                "Gasto":     brl,
                "Investido": investido,
                "% Invest.": pct_inv,
            })

        df_p = pd.DataFrame(rows_p).sort_values("Gasto", ascending=False)

        fmt_p = {"Gasto": "R$ {:,.2f}"}
        if df_p["Investido"].notna().any():
            fmt_p["Investido"] = "R$ {:,.2f}"
        if df_p["% Invest."].notna().any():
            fmt_p["% Invest."] = "{:.1f}%"

        st.dataframe(
            _table_style(df_p).format(fmt_p, na_rep="—"),
            use_container_width=True, hide_index=True,
        )
        st.caption(f"{len(df_p)} lines · total: {fmt_brl(spend_brl)}")


# ═══════════════════════════════════════════════════════════════════════════════
# PAGE — ATENÇÃO
# ═══════════════════════════════════════════════════════════════════════════════
if active_page == "⚠️ Atenção":
    # Lines sem token
    no_token_rows = []
    for pname, pdata in results.items():
        if pdata["status"] != "ok":
            continue
        for line in pdata.get("lines", []):
            if not extract_token_from_line(line["name"]):
                no_token_rows.append({
                    "Plataforma": pname,
                    "Line":       line["name"],
                    "Gasto":      to_brl_smart(line["spend"], pdata["currency"]),
                })

    st.markdown('<p class="sec-label">Sem token identificado</p><p class="sec-title">Lines sem Token</p><p class="sec-sub">Gasto que não pode ser cruzado com a planilha</p>', unsafe_allow_html=True)
    if no_token_rows:
        df_nt = pd.DataFrame(no_token_rows).sort_values("Gasto", ascending=False)
        total_nt = df_nt["Gasto"].sum()
        st.dataframe(
            _table_style(df_nt).format({"Gasto": "R$ {:,.2f}"}),
            use_container_width=True, hide_index=True,
        )
        st.caption(f"Total sem token: R$ {total_nt:,.2f}")
    else:
        st.success("Todas as lines têm token identificado.")

    st.divider()

    # Lines fora da vigência
    out_rows = []
    for pname, pdata in results.items():
        if pdata["status"] != "ok":
            continue
        for line in pdata.get("lines", []):
            token = extract_token_from_line(line["name"])
            if not token:
                continue
            camp = all_campaigns.get(token)
            if not camp:
                continue
            s_c, e_c = camp.get("start"), camp.get("end")
            if (s_c and s_c > month_end) or (e_c and e_c < start):
                brl = to_brl_smart(line["spend"], pdata["currency"])
                out_rows.append({
                    "Plataforma": pname,
                    "Token":      token,
                    "Cliente":    camp["cliente"],
                    "Campanha":   camp["campanha"],
                    "Vigência":   f"{s_c.strftime('%d/%m/%Y') if s_c else '?'} → {e_c.strftime('%d/%m/%Y') if e_c else '?'}",
                    "Gasto":      brl,
                })

    st.markdown('<p class="sec-label">Fora da vigência</p><p class="sec-title">Gasto fora do mês vigente</p><p class="sec-sub">Campanhas cujas datas não cobrem o período atual</p>', unsafe_allow_html=True)
    if out_rows:
        df_out = pd.DataFrame(out_rows).sort_values("Gasto", ascending=False)
        total_out = df_out["Gasto"].sum()
        st.warning(f"R$ {total_out:,.2f} em campanhas fora do período vigente")
        st.dataframe(
            _table_style(df_out).format({"Gasto": "R$ {:,.2f}"}),
            use_container_width=True, hide_index=True,
        )
    else:
        st.success("Nenhum gasto em campanhas fora do mês vigente.")

