/**
 * Search.jsx  (React 17)
 * ------------------------------------------------------------------
 * JQL-style search bar for an AMPS-backed AG Grid.
 *
 *   const [ampsFilter, setAmpsFilter] = useState('');
 *   const [ampsOrderBy, setAmpsOrderBy] = useState('');   // optional
 *
 *   <Search
 *     gridApi={gridApi}              // from onGridReady — drives field suggestions
 *     setFilter={setAmpsFilter}      // receives the compiled AMPS content filter string
 *   />
 *
 * Whenever the query is valid, setFilter is called (debounced) with the
 * AMPS filter, e.g.  (/status = 'Open' OR /status = 'Blocked') AND /qty > 100
 * Clearing the query calls setFilter('').
 *
 * Optional props:
 *   columnApi            pre-v31 AG Grid column API (v31+ merged it into gridApi)
 *   setOrderBy           receives the AMPS `orderby` option string from ORDER BY
 *                        clauses (e.g. "/price DESC, /symbol ASC"), or '' if none
 *   autoApply            default true — push to setFilter on every valid edit;
 *                        false = only on Enter / Search button
 *   debounceMs           default 400
 *   storageKey           localStorage key for recent searches
 *   placeholder          input placeholder text
 *
 * Keyword search:
 *   Bare terms (no field, no operator) search across ALL VISIBLE grid
 *   columns and can be chained:
 *     AAPL.OQ OR MSFT.N      -> contains-match fan-out over visible columns
 *     AAPL.OQ AND "Filled"   -> both terms must match somewhere in the row
 *     > 100  /  <= 99.5      -> bare comparison across visible numeric columns
 *   Keyword terms can be mixed freely with field clauses:
 *     AAPL.OQ AND qty > 1000
 *
 * Interaction model:
 *   - typing: prefix-filtered autocomplete (Fields / Operators / Values / Keywords)
 *   - clicking an existing token: shows the FULL list for that slot and the
 *     selection REPLACES the token in place
 *   - ↑ ↓ navigate, Tab/Enter accept, Esc closes, Ctrl+Space reopens,
 *     Enter (popup closed) applies
 */
import React, {
  useState, useRef, useMemo, useEffect, useCallback,
} from 'react';
import {
  jqlToAmps, getCompletionContext, CONTEXT, ParseError, encodeFieldName,
} from './uiQueryToAmps';

/* ===========================================================================
 * Field extraction from the AG Grid API
 * =========================================================================== */

// Design-system convention: right-aligned cells are numeric. Extend this
// list if your grid uses other alignment/format classes for numbers.
const NUMERIC_CELL_CLASSES = ['lmn-text-right'];

function cellClassIndicatesNumber(colDef) {
  let cls = colDef.cellClass;
  if (typeof cls === 'function') {
    // cellClass can be (params) => string | string[]; probe it defensively
    try { cls = cls({ value: 0, data: {}, colDef }); } catch (e) { cls = null; }
  }
  const list = (Array.isArray(cls) ? cls : typeof cls === 'string' ? [cls] : [])
    .filter((c) => typeof c === 'string')
    .flatMap((c) => c.split(/\s+/));
  return list.some((c) => NUMERIC_CELL_CLASSES.includes(c));
}

function inferDataType(colDef) {
  if (typeof colDef.cellDataType === 'string') {
    if (colDef.cellDataType.startsWith('number')) return 'number';
    if (colDef.cellDataType.startsWith('date')) return 'date';
    if (colDef.cellDataType === 'boolean') return 'boolean';
    return 'string';
  }
  const types = Array.isArray(colDef.type) ? colDef.type : colDef.type ? [colDef.type] : [];
  if (types.some((t) => /numeric|number/i.test(t))) return 'number';
  if (types.some((t) => /date/i.test(t))) return 'date';
  if (colDef.filter === 'agNumberColumnFilter') return 'number';
  if (colDef.filter === 'agDateColumnFilter') return 'date';
  // grids where every colDef is untyped but numeric columns carry a
  // right-align class (e.g. cellClass: 'lmn-text-right')
  if (cellClassIndicatesNumber(colDef)) return 'number';
  if (colDef.context && colDef.context.dataType) return colDef.context.dataType;
  return 'string';
}

function flattenColDefs(defs, out) {
  (defs || []).forEach((def) => {
    if (def.children) { flattenColDefs(def.children, out); return; }
    if (!def.field) return; // valueGetter-only columns can't be filtered server side
    if (def.suppressJqlSearch || (def.context && def.context.suppressJqlSearch)) return;
    out.push({
      field: def.field,
      headerName: def.headerName || def.field,
      dataType: inferDataType(def),
      colDef: def,
    });
  });
}

function extractFieldsFromGrid(gridApi, columnApi) {
  const out = [];
  if (gridApi && typeof gridApi.getColumnDefs === 'function') {
    flattenColDefs(gridApi.getColumnDefs(), out);
  }
  if (out.length === 0) {
    const colApi = columnApi || gridApi; // v31 merged the APIs
    const cols =
      (colApi && typeof colApi.getAllColumns === 'function' && colApi.getAllColumns()) ||
      (colApi && typeof colApi.getColumns === 'function' && colApi.getColumns()) ||
      [];
    cols.forEach((col) => {
      const def = col.getColDef ? col.getColDef() : col;
      flattenColDefs([def], out);
    });
  }
  return out;
}

function buildFieldMap(fields) {
  const map = new Map();
  fields.forEach((f) => {
    map.set(f.field.toLowerCase(), f);
    map.set(f.headerName.toLowerCase(), f);
    const camel = f.headerName
      .replace(/[^A-Za-z0-9]+(.)/g, (_, c) => c.toUpperCase())
      .replace(/[^A-Za-z0-9]/g, '');
    if (camel) map.set(camel.toLowerCase(), f);
    // URL-encoded header name: what the dropdown inserts ("Order%20Status")
    map.set(encodeFieldName(f.headerName).toLowerCase(), f);
  });
  return map;
}

/** Set of colDef.field values for currently displayed columns, or null if undeterminable. */
function getVisibleFieldSet(gridApi, columnApi) {
  const api = (columnApi && typeof columnApi.getAllDisplayedColumns === 'function') ? columnApi : gridApi;
  if (!api || typeof api.getAllDisplayedColumns !== 'function') return null;
  const cols = api.getAllDisplayedColumns() || [];
  return new Set(
    cols
      .map((c) => (c.getColDef ? c.getColDef().field : c.field))
      .filter(Boolean)
  );
}

function useGridFields(gridApi, columnApi) {
  const [fields, setFields] = useState([]);
  const [visibleSet, setVisibleSet] = useState(null);

  const refresh = useCallback(() => {
    if (!gridApi) return;
    setFields(extractFieldsFromGrid(gridApi, columnApi));
    setVisibleSet(getVisibleFieldSet(gridApi, columnApi));
  }, [gridApi, columnApi]);

  useEffect(() => {
    refresh();
    if (!gridApi || typeof gridApi.addEventListener !== 'function') return undefined;
    const events = [
      'gridColumnsChanged', 'newColumnsLoaded', 'columnEverythingChanged',
      'displayedColumnsChanged', 'columnVisible', // keep keyword scope in sync with hidden/shown columns
    ];
    events.forEach((e) => gridApi.addEventListener(e, refresh));
    return () => {
      events.forEach((e) => {
        try { gridApi.removeEventListener(e, refresh); } catch (err) { /* grid destroyed */ }
      });
    };
  }, [gridApi, refresh]);

  // Keyword terms fan out across VISIBLE columns only; if visibility can't be
  // determined (mocked api, very old grid), fall back to all fields.
  const visibleFields = useMemo(
    () => (visibleSet ? fields.filter((f) => visibleSet.has(f.field)) : fields),
    [fields, visibleSet]
  );

  return {
    fields,
    visibleFields,
    fieldMap: useMemo(() => buildFieldMap(fields), [fields]),
  };
}

/* ===========================================================================
 * Static suggestion sets
 * =========================================================================== */

const OPERATORS = [
  { label: '=',  hint: 'equals' },
  { label: '!=', hint: 'not equals' },
  { label: '~',  hint: 'contains (LIKE)' },
  { label: '!~', hint: 'does not contain' },
  { label: '>',  hint: 'greater than', numeric: true },
  { label: '>=', hint: 'greater or equal', numeric: true },
  { label: '<',  hint: 'less than', numeric: true },
  { label: '<=', hint: 'less or equal', numeric: true },
  { label: 'IN',     hint: 'in list — expands to OR' },
  { label: 'NOT IN', hint: 'not in list' },
  { label: 'IS EMPTY',     hint: 'null or blank' },
  { label: 'IS NOT EMPTY', hint: 'has a value' },
];

const JOINERS = [
  { label: 'AND', hint: 'all conditions match' },
  { label: 'OR',  hint: 'any condition matches' },
  { label: 'ORDER BY', hint: 'sort results (AMPS orderby option)' },
];

const MAX_RECENT = 8;

/* ===========================================================================
 * Styles (scoped by the .jqlbar prefix; extract to a .css file if preferred)
 * =========================================================================== */

const STYLES = `
.jqlbar{position:relative;font-family:-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;font-size:13px}
.jqlbar__inputRow{display:flex;align-items:center;gap:6px;border:1px solid #c1c7d0;border-radius:3px;background:#fff;padding:4px 6px;transition:border-color .12s,box-shadow .12s}
.jqlbar__inputRow:focus-within{border-color:#4c9aff;box-shadow:0 0 0 2px rgba(76,154,255,.25)}
.jqlbar__inputRow--error{border-color:#de350b}
.jqlbar__inputRow--error:focus-within{border-color:#de350b;box-shadow:0 0 0 2px rgba(222,53,11,.2)}
.jqlbar__inputRow--valid{border-color:#36b37e}
.jqlbar__badge{flex:none;font-size:10px;font-weight:700;letter-spacing:.08em;color:#5e6c84;background:#f4f5f7;border:1px solid #dfe1e6;border-radius:3px;padding:2px 5px;user-select:none}
.jqlbar__input{flex:1;min-width:0;border:none;outline:none;font-family:"SF Mono","Cascadia Code",Consolas,Menlo,monospace;font-size:13px;color:#172b4d;background:transparent;padding:3px 2px}
.jqlbar__input::placeholder{color:#97a0af;font-style:italic}
.jqlbar__clear{flex:none;border:none;background:transparent;color:#6b778c;font-size:16px;line-height:1;cursor:pointer;padding:2px 6px;border-radius:3px}
.jqlbar__clear:hover{background:#ebecf0;color:#172b4d}
.jqlbar__apply{flex:none;border:none;border-radius:3px;background:#0052cc;color:#fff;font-size:12px;font-weight:600;padding:5px 12px;cursor:pointer}
.jqlbar__apply:hover:not(:disabled){background:#0747a6}
.jqlbar__apply:disabled{background:#a5adba;cursor:not-allowed}
.jqlbar__apply:focus-visible,.jqlbar__clear:focus-visible{outline:2px solid #4c9aff;outline-offset:1px}
.jqlbar__popup{position:absolute;top:calc(100% + 2px);left:0;right:0;z-index:1000;max-height:320px;overflow-y:auto;background:#fff;border:1px solid #c1c7d0;border-radius:3px;box-shadow:0 4px 12px rgba(9,30,66,.18)}
.jqlbar__group + .jqlbar__group{border-top:1px solid #f4f5f7}
.jqlbar__groupTitle{font-size:10px;font-weight:700;letter-spacing:.08em;text-transform:uppercase;color:#6b778c;padding:7px 10px 3px;user-select:none}
.jqlbar__item{display:flex;align-items:baseline;justify-content:space-between;gap:12px;padding:5px 10px;cursor:pointer}
.jqlbar__item--active,.jqlbar__item:hover{background:#deebff}
.jqlbar__itemLabel{font-family:"SF Mono","Cascadia Code",Consolas,Menlo,monospace;font-size:12.5px;color:#172b4d;white-space:nowrap}
.jqlbar__itemLabel--mono{overflow:hidden;text-overflow:ellipsis}
.jqlbar__itemHint{font-size:11px;color:#6b778c;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jqlbar__status{display:flex;align-items:center;gap:8px;min-height:22px;padding:3px 2px 0;font-size:11.5px}
.jqlbar__statusOk{flex:none;font-size:9.5px;font-weight:700;letter-spacing:.08em;color:#006644;background:#e3fcef;border-radius:3px;padding:2px 5px}
.jqlbar__amps{font-family:"SF Mono",Consolas,Menlo,monospace;font-size:11px;color:#42526e;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.jqlbar__statusErr{color:#de350b}
.jqlbar__statusHint{color:#97a0af}
@media (prefers-reduced-motion:reduce){.jqlbar__inputRow{transition:none}}
`;

/* ===========================================================================
 * <Search />
 * =========================================================================== */

export default function Search({
  gridApi,
  columnApi,
  setFilter,
  setOrderBy,
  autoApply = true,
  debounceMs = 400,
  storageKey = 'jql-amps-recent',
  placeholder = 'e.g.  AAPL.OQ OR MSFT.N   ·   symbol = "IBM" AND qty > 1000 ORDER BY price DESC',
}) {
  const { fields, visibleFields, fieldMap } = useGridFields(gridApi, columnApi);

  const [query, setQuery] = useState('');
  const [caret, setCaret] = useState(0);
  const [open, setOpen] = useState(false);
  const [highlight, setHighlight] = useState(0);
  // browse = caret was placed by clicking on an existing token: show the
  // FULL suggestion list for that slot and replace the token on select.
  // typing (onChange) switches back to prefix-filtered autocomplete.
  const [browse, setBrowse] = useState(false);
  const [recent, setRecent] = useState(() => {
    try {
      const raw = window.localStorage.getItem(storageKey);
      return raw ? JSON.parse(raw) : [];
    } catch (e) { return []; }
  });

  const inputRef = useRef(null);
  const listRef = useRef(null);
  const blurTimer = useRef(null);
  const debounceTimer = useRef(null);
  const lastPushed = useRef({ filter: null, orderBy: null });

  // ---- compile on every keystroke (cheap) ---------------------------------
  const compiled = useMemo(() => {
    const trimmed = query.trim();
    if (!trimmed) return { status: 'empty', ampsFilter: '', ampsOrderBy: '' };
    try {
      const { ampsFilter, ampsOrderBy } = jqlToAmps(trimmed, fieldMap, { keywordFields: visibleFields });
      return { status: 'valid', ampsFilter, ampsOrderBy };
    } catch (e) {
      return {
        status: 'error',
        message: e.message,
        position: e instanceof ParseError ? e.position : null,
      };
    }
  }, [query, fieldMap, visibleFields]);

  // ---- push the compiled filter into the consumer's state ------------------
  const push = useCallback((ampsFilter, ampsOrderBy) => {
    if (lastPushed.current.filter !== ampsFilter) {
      lastPushed.current.filter = ampsFilter;
      setFilter && setFilter(ampsFilter);
    }
    if (setOrderBy && lastPushed.current.orderBy !== ampsOrderBy) {
      lastPushed.current.orderBy = ampsOrderBy;
      setOrderBy(ampsOrderBy);
    }
  }, [setFilter, setOrderBy]);

  const saveRecent = useCallback((jql) => {
    setRecent((prev) => {
      const next = [jql, ...prev.filter((q) => q !== jql)].slice(0, MAX_RECENT);
      try { window.localStorage.setItem(storageKey, JSON.stringify(next)); } catch (e) { /* private mode */ }
      return next;
    });
  }, [storageKey]);

  /** explicit = Enter / Search button / recent click (also saves to recents) */
  const apply = useCallback((q, explicit = false) => {
    const jql = (q !== undefined ? q : query).trim();
    if (!jql) { push('', ''); return; }
    try {
      const { ampsFilter, ampsOrderBy } = jqlToAmps(jql, fieldMap, { keywordFields: visibleFields });
      if (explicit) saveRecent(jql);
      push(ampsFilter, ampsOrderBy);
    } catch (e) { /* invalid — status row already shows the error */ }
  }, [query, fieldMap, visibleFields, push, saveRecent]);

  // auto-apply (debounced) on every valid edit; clears when query is emptied
  useEffect(() => {
    if (!autoApply) return undefined;
    if (compiled.status === 'error') return undefined;
    clearTimeout(debounceTimer.current);
    debounceTimer.current = setTimeout(() => {
      push(compiled.ampsFilter, compiled.ampsOrderBy);
    }, debounceMs);
    return () => clearTimeout(debounceTimer.current);
  }, [autoApply, compiled.status, compiled.ampsFilter, compiled.ampsOrderBy, debounceMs, push]);

  // ---- completion context ----------------------------------------------------
  const completion = useMemo(
    () => getCompletionContext(query, caret),
    [query, caret]
  );

  // What the suggestion list filters on. In browse mode (user clicked an
  // existing token) we show everything valid for that slot; while typing we
  // prefix-filter, stripping the opening quote of string literals so
  // clicking inside `"Buy"` still matches value suggestions.
  const effectivePartial = useMemo(() => {
    if (browse && completion.partialType) return '';
    let p = completion.partial;
    if (p && (p[0] === '"' || p[0] === "'")) p = p.slice(1);
    return p;
  }, [browse, completion]);

  // ---- build categorized suggestion list -------------------------------------
  const suggestions = useMemo(() => {
    const partial = effectivePartial.toLowerCase();
    const match = (s) => !partial || s.toLowerCase().startsWith(partial);
    const items = [];

    const pushFields = () => fields.filter((f) =>
      match(f.field) || match(f.headerName) || match(encodeFieldName(f.headerName))
    ).forEach((f) => items.push({
      category: 'Fields',
      insert: encodeFieldName(f.headerName), // "Order Status" -> Order%20Status in the query
      label: f.headerName,                   // human-readable in the dropdown
      hint: `${f.field} · ${f.dataType}`,
    }));

    switch (completion.context) {
      case CONTEXT.FIELD:
      case CONTEXT.ORDER_FIELD:
        pushFields();
        if (completion.context === CONTEXT.FIELD) {
          if (match('NOT')) items.push({ category: 'Keywords', insert: 'NOT', label: 'NOT', hint: 'negate a group' });
          if (match('(')) items.push({ category: 'Keywords', insert: '(', label: '(', hint: 'open group', noSpace: true });
          // bare comparisons fan out across visible numeric/text columns
          ['>', '>=', '<', '<='].filter(match).forEach((op) =>
            items.push({ category: 'Operators', insert: op, label: op, hint: 'compare across visible fields' }));
        }
        break;

      case CONTEXT.OPERATOR: {
        const def = completion.activeField
          ? fieldMap.get(String(completion.activeField).toLowerCase())
          : null;
        // Unknown word -> it's a keyword term, not a field: allow every
        // operator shape after it is replaced, but lead with AND/OR.
        const isKnownField = !!def;
        const numeric = def && (def.dataType === 'number' || def.dataType === 'date');
        OPERATORS
          .filter((op) => (!isKnownField || numeric || !op.numeric))
          .filter((op) => match(op.label))
          .forEach((op) => items.push({ category: 'Operators', insert: op.label, label: op.label, hint: op.hint }));
        // The word before the caret may be a bare keyword term
        // (e.g. AAPL.OQ), so chaining with AND / OR is also valid here.
        [{ label: 'AND', hint: 'chain keyword/clause' }, { label: 'OR', hint: 'chain keyword/clause' }]
          .filter((j) => match(j.label))
          .forEach((j) => items.push({ category: 'Keywords', insert: j.label, label: j.label, hint: j.hint }));
        break;
      }

      case CONTEXT.VALUE:
      case CONTEXT.IN_LIST:
        // No dropdown in value slots — after an operator the user types the
        // value (and the opening paren of an IN list) freely.
        break;

      case CONTEXT.IS_WHAT:
        ['EMPTY', 'NOT EMPTY', 'NULL', 'NOT NULL'].filter(match).forEach((k) =>
          items.push({ category: 'Keywords', insert: k, label: k, hint: 'null / blank test' }));
        break;

      case CONTEXT.JOINER:
        JOINERS.filter((j) => match(j.label)).forEach((j) =>
          items.push({ category: 'Keywords', insert: j.label, label: j.label, hint: j.hint }));
        break;

      case CONTEXT.ORDER_DIR:
        ['ASC', 'DESC'].filter(match).forEach((d) =>
          items.push({ category: 'Keywords', insert: d, label: d, hint: 'sort direction' }));
        break;

      default:
        break;
    }
    return items;
  }, [completion, effectivePartial, fields, fieldMap]);

  useEffect(() => { setHighlight(0); }, [suggestions.length, effectivePartial]);

  // keep highlighted row scrolled into view
  useEffect(() => {
    if (!listRef.current) return;
    const el = listRef.current.querySelector('[data-active="true"]');
    if (el && el.scrollIntoView) el.scrollIntoView({ block: 'nearest' });
  }, [highlight]);

  // ---- editing helpers ---------------------------------------------------------
  const syncCaret = () => {
    if (inputRef.current) setCaret(inputRef.current.selectionStart || 0);
  };

  const insertSuggestion = (item) => {
    const { replaceStart, replaceEnd } = completion;
    const before = query.slice(0, replaceStart);
    let after = query.slice(Math.max(replaceEnd, caret));
    const space = item.noSpace ? '' : ' ';
    const inserted = item.insert + space;
    if (space && after.startsWith(' ')) after = after.slice(1); // avoid double space on in-place replace
    const next = before + inserted + after;
    const newCaret = (before + inserted).length;

    setQuery(next);
    setOpen(true);
    setBrowse(false); // back to prefix-filtered autocomplete after the swap
    requestAnimationFrame(() => {
      if (inputRef.current) {
        inputRef.current.focus();
        inputRef.current.setSelectionRange(newCaret, newCaret);
        setCaret(newCaret);
      }
    });
  };

  const onKeyDown = (e) => {
    if (e.key === 'Enter') {
      if (open && suggestions.length > 0) {
        e.preventDefault();
        insertSuggestion(suggestions[highlight]);
      } else {
        e.preventDefault();
        setOpen(false);
        apply(undefined, true);
      }
      return;
    }
    if (!open && (e.key === 'ArrowDown' || (e.ctrlKey && e.key === ' '))) {
      e.preventDefault();
      setOpen(true);
      return;
    }
    if (open) {
      if (e.key === 'ArrowDown') { e.preventDefault(); setHighlight((h) => Math.min(h + 1, suggestions.length - 1)); }
      else if (e.key === 'ArrowUp') { e.preventDefault(); setHighlight((h) => Math.max(h - 1, 0)); }
      else if (e.key === 'Tab' && suggestions.length > 0) { e.preventDefault(); insertSuggestion(suggestions[highlight]); }
      else if (e.key === 'Escape') { setOpen(false); }
    }
  };

  // group suggestions for rendering
  const grouped = useMemo(() => {
    const order = ['Fields', 'Operators', 'Values', 'Keywords'];
    const byCat = new Map();
    suggestions.forEach((s, i) => {
      if (!byCat.has(s.category)) byCat.set(s.category, []);
      byCat.get(s.category).push({ ...s, index: i });
    });
    return order.filter((c) => byCat.has(c)).map((c) => ({ category: c, items: byCat.get(c) }));
  }, [suggestions]);

  const showRecent = open && !query.trim() && recent.length > 0;

  return (
    <div className="jqlbar">
      <style>{STYLES}</style>
      <div className={`jqlbar__inputRow jqlbar__inputRow--${compiled.status}`}>
        <span className="jqlbar__badge">JQL</span>
        <input
          ref={inputRef}
          className="jqlbar__input"
          type="text"
          spellCheck={false}
          autoComplete="off"
          placeholder={placeholder}
          value={query}
          onChange={(e) => { setQuery(e.target.value); setOpen(true); setBrowse(false); syncCaret(); }}
          onKeyDown={onKeyDown}
          onKeyUp={syncCaret}
          onClick={() => { syncCaret(); setBrowse(true); setOpen(true); }}
          onFocus={() => { clearTimeout(blurTimer.current); setOpen(true); }}
          onBlur={() => { blurTimer.current = setTimeout(() => setOpen(false), 150); }}
          aria-label="JQL filter query"
        />
        {query && (
          <button
            type="button"
            className="jqlbar__clear"
            title="Clear query and remove AMPS filter"
            onMouseDown={(e) => e.preventDefault()}
            onClick={() => { setQuery(''); setCaret(0); apply(''); inputRef.current && inputRef.current.focus(); }}
          >
            ×
          </button>
        )}
        <button
          type="button"
          className="jqlbar__apply"
          disabled={compiled.status === 'error'}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() => apply(undefined, true)}
        >
          Search
        </button>
      </div>

      {open && (suggestions.length > 0 || showRecent) && (
        <div
          className="jqlbar__popup"
          ref={listRef}
          onMouseDown={(e) => e.preventDefault() /* keep input focus */}
        >
          {showRecent && (
            <div className="jqlbar__group">
              <div className="jqlbar__groupTitle">Recent</div>
              {recent.map((r) => (
                <div
                  key={r}
                  className="jqlbar__item"
                  onClick={() => { setQuery(r); setCaret(r.length); setOpen(false); apply(r, true); }}
                >
                  <span className="jqlbar__itemLabel jqlbar__itemLabel--mono">{r}</span>
                </div>
              ))}
            </div>
          )}
          {grouped.map((g) => (
            <div className="jqlbar__group" key={g.category}>
              <div className="jqlbar__groupTitle">{g.category}</div>
              {g.items.map((item) => (
                <div
                  key={`${g.category}-${item.label}`}
                  data-active={item.index === highlight ? 'true' : 'false'}
                  className={`jqlbar__item${item.index === highlight ? ' jqlbar__item--active' : ''}`}
                  onMouseEnter={() => setHighlight(item.index)}
                  onClick={() => insertSuggestion(item)}
                >
                  <span className="jqlbar__itemLabel">{item.label}</span>
                  {item.hint && <span className="jqlbar__itemHint">{item.hint}</span>}
                </div>
              ))}
            </div>
          ))}
        </div>
      )}

      <div className="jqlbar__status">
        {compiled.status === 'valid' && (
          <>
            <span className="jqlbar__statusOk">AMPS</span>
            <code className="jqlbar__amps">
              {compiled.ampsFilter || '(no filter)'}
              {compiled.ampsOrderBy ? `   |   orderby: ${compiled.ampsOrderBy}` : ''}
            </code>
          </>
        )}
        {compiled.status === 'error' && (
          <span className="jqlbar__statusErr">
            {compiled.message}
            {compiled.position != null ? ` (at position ${compiled.position})` : ''}
          </span>
        )}
        {compiled.status === 'empty' && (
          <span className="jqlbar__statusHint">
            Type a keyword (searches all visible columns) or a field name — chain with AND / OR. Enter applies the filter.
          </span>
        )}
      </div>
    </div>
  );
}
