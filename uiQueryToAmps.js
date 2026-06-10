/**
 * uiQueryToAmps.js
 * ------------------------------------------------------------------
 * UI query (JQL-style) -> AMPS content filter compiler. Pure JS, no React.
 *
 * Pipeline:  tokenize() -> parse() (AST) -> buildAmpsFilter()
 *
 * Supported JQL subset:
 *   field = value            field != value
 *   field > | >= | < | <=    (numeric / date comparisons)
 *   field ~ "text"           contains  -> AMPS LIKE '(?i)...'
 *   field !~ "text"          not-contains
 *   field IN (a, b, c)       -> expanded to OR chain (AMPS has no IN)
 *   field NOT IN (a, b, c)
 *   field IS EMPTY | IS NULL
 *   field IS NOT EMPTY | IS NOT NULL
 *   AND / OR / NOT, parentheses
 *   ORDER BY field [ASC|DESC] [, field ...]   -> returned separately,
 *       pass it to AMPS as the `orderby` subscription option.
 *
 * AMPS specifics handled here:
 *   - identifiers are XPath style:  colDef.field "order.qty" -> /order/qty
 *   - string literals use single quotes, embedded quotes doubled ('')
 *   - LIKE takes a PCRE regex; we escape user text and prefix (?i)
 *   - IS NULL / IS NOT NULL for null tests; EMPTY also checks = ''
 */

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

export const TOKEN = {
  FIELD: 'field',
  OPERATOR: 'operator',
  KEYWORD: 'keyword',
  STRING: 'string',
  NUMBER: 'number',
  LPAREN: 'lparen',
  RPAREN: 'rparen',
  COMMA: 'comma',
  ERROR: 'error',
};

const KEYWORDS = new Set([
  'AND', 'OR', 'NOT', 'IN', 'IS', 'EMPTY', 'NULL',
  'ORDER', 'BY', 'ASC', 'DESC',
]);

const OPERATOR_RE = /^(!=|>=|<=|!~|=|>|<|~)/;
const NUMBER_RE = /^-?\d+(\.\d+)?(?![\w.])/;
const WORD_RE = /^[A-Za-z_][A-Za-z0-9_.$%-]*/; // % so URL-encoded header names (Order%20Status) stay one token

/**
 * @param {string} input
 * @returns {Array<{type:string, value:string, raw:string, start:number, end:number}>}
 */
export function tokenize(input) {
  const tokens = [];
  let i = 0;

  while (i < input.length) {
    const ch = input[i];

    if (/\s/.test(ch)) { i++; continue; }

    // Quoted strings: "..." or '...'
    if (ch === '"' || ch === "'") {
      const quote = ch;
      let j = i + 1;
      let value = '';
      let closed = false;
      while (j < input.length) {
        if (input[j] === '\\' && j + 1 < input.length) { value += input[j + 1]; j += 2; continue; }
        if (input[j] === quote) { closed = true; j++; break; }
        value += input[j]; j++;
      }
      tokens.push({
        type: closed ? TOKEN.STRING : TOKEN.ERROR,
        value,
        raw: input.slice(i, j),
        start: i,
        end: j,
        unterminated: !closed,
      });
      i = j;
      continue;
    }

    if (ch === '(') { tokens.push({ type: TOKEN.LPAREN, value: '(', raw: '(', start: i, end: i + 1 }); i++; continue; }
    if (ch === ')') { tokens.push({ type: TOKEN.RPAREN, value: ')', raw: ')', start: i, end: i + 1 }); i++; continue; }
    if (ch === ',') { tokens.push({ type: TOKEN.COMMA, value: ',', raw: ',', start: i, end: i + 1 }); i++; continue; }

    const rest = input.slice(i);

    const opMatch = rest.match(OPERATOR_RE);
    if (opMatch) {
      tokens.push({ type: TOKEN.OPERATOR, value: opMatch[0], raw: opMatch[0], start: i, end: i + opMatch[0].length });
      i += opMatch[0].length;
      continue;
    }

    const numMatch = rest.match(NUMBER_RE);
    if (numMatch) {
      tokens.push({ type: TOKEN.NUMBER, value: numMatch[0], raw: numMatch[0], start: i, end: i + numMatch[0].length });
      i += numMatch[0].length;
      continue;
    }

    const wordMatch = rest.match(WORD_RE);
    if (wordMatch) {
      const word = wordMatch[0];
      const upper = word.toUpperCase();
      tokens.push({
        type: KEYWORDS.has(upper) ? TOKEN.KEYWORD : TOKEN.FIELD,
        value: KEYWORDS.has(upper) ? upper : word,
        raw: word,
        start: i,
        end: i + word.length,
      });
      i += word.length;
      continue;
    }

    tokens.push({ type: TOKEN.ERROR, value: ch, raw: ch, start: i, end: i + 1 });
    i++;
  }

  return tokens;
}

// ---------------------------------------------------------------------------
// Parser  (recursive descent)
// ---------------------------------------------------------------------------
//
//   query    := orExpr [ ORDER BY orderItem (, orderItem)* ]
//   orExpr   := andExpr ( OR andExpr )*
//   andExpr  := notExpr ( AND notExpr )*
//   notExpr  := NOT notExpr | primary
//   primary  := '(' orExpr ')' | clause
//   clause   := field op value
//             | field [NOT] IN '(' value (, value)* ')'
//             | field IS [NOT] (EMPTY | NULL)

class ParseError extends Error {
  constructor(message, token) {
    super(message);
    this.token = token || null;
    this.position = token ? token.start : null;
  }
}

class Parser {
  constructor(tokens) {
    this.tokens = tokens;
    this.pos = 0;
  }
  peek(offset = 0) { return this.tokens[this.pos + offset] || null; }
  next() { return this.tokens[this.pos++] || null; }
  expect(type, value) {
    const t = this.next();
    if (!t || t.type !== type || (value !== undefined && t.value !== value)) {
      throw new ParseError(
        `Expected ${value || type}${t ? ` but found "${t.raw}"` : ' but reached end of query'}`,
        t
      );
    }
    return t;
  }

  parseQuery() {
    if (!this.peek()) return { where: null, orderBy: [] };

    let where = null;
    // Allow a query that is *only* an ORDER BY clause
    if (!(this.peek().type === TOKEN.KEYWORD && this.peek().value === 'ORDER')) {
      where = this.parseOr();
    }

    let orderBy = [];
    const t = this.peek();
    if (t && t.type === TOKEN.KEYWORD && t.value === 'ORDER') {
      this.next();
      this.expect(TOKEN.KEYWORD, 'BY');
      orderBy = this.parseOrderList();
    }

    const trailing = this.peek();
    if (trailing) throw new ParseError(`Unexpected "${trailing.raw}"`, trailing);

    return { where, orderBy };
  }

  parseOrderList() {
    const items = [];
    for (;;) {
      const f = this.next();
      if (!f || f.type !== TOKEN.FIELD) {
        throw new ParseError('Expected a field name after ORDER BY', f);
      }
      let direction = 'ASC';
      const d = this.peek();
      if (d && d.type === TOKEN.KEYWORD && (d.value === 'ASC' || d.value === 'DESC')) {
        direction = d.value;
        this.next();
      }
      items.push({ field: f.value, direction });
      const c = this.peek();
      if (c && c.type === TOKEN.COMMA) { this.next(); continue; }
      break;
    }
    return items;
  }

  parseOr() {
    let left = this.parseAnd();
    for (;;) {
      const t = this.peek();
      if (t && t.type === TOKEN.KEYWORD && t.value === 'OR') {
        this.next();
        const right = this.parseAnd();
        left = left.type === 'or'
          ? { type: 'or', children: [...left.children, right] }
          : { type: 'or', children: [left, right] };
      } else break;
    }
    return left;
  }

  parseAnd() {
    let left = this.parseNot();
    for (;;) {
      const t = this.peek();
      if (t && t.type === TOKEN.KEYWORD && t.value === 'AND') {
        this.next();
        const right = this.parseNot();
        left = left.type === 'and'
          ? { type: 'and', children: [...left.children, right] }
          : { type: 'and', children: [left, right] };
      } else break;
    }
    return left;
  }

  parseNot() {
    const t = this.peek();
    if (t && t.type === TOKEN.KEYWORD && t.value === 'NOT') {
      this.next();
      return { type: 'not', child: this.parseNot() };
    }
    return this.parsePrimary();
  }

  parsePrimary() {
    const t = this.peek();
    if (!t) throw new ParseError('Unexpected end of query');

    if (t.type === TOKEN.LPAREN) {
      this.next();
      const expr = this.parseOr();
      this.expect(TOKEN.RPAREN);
      return expr;
    }
    return this.parseClause();
  }

  parseClause() {
    const t0 = this.peek();
    if (!t0) throw new ParseError('Unexpected end of query');

    // Bare comparison across all searchable fields:  > 100, <= 99.5, ~ "abc"
    if (t0.type === TOKEN.OPERATOR) {
      this.next();
      const v = this.next();
      if (!v || (v.type !== TOKEN.STRING && v.type !== TOKEN.NUMBER && v.type !== TOKEN.FIELD)) {
        throw new ParseError(`Expected a value after "${t0.value}"`, v);
      }
      return { type: 'clause', op: 'cmp_all', cmp: t0.value, value: v.value, valueKind: v.type, opToken: t0 };
    }

    // Quoted or numeric bare keyword:  "jane street", 500
    if (t0.type === TOKEN.STRING || t0.type === TOKEN.NUMBER) {
      this.next();
      return { type: 'clause', op: 'keyword', value: t0.value, valueKind: t0.type, fieldToken: t0 };
    }

    const fieldTok = this.next();
    if (!fieldTok || fieldTok.type !== TOKEN.FIELD) {
      throw new ParseError(
        `Expected a field name or search term${fieldTok ? ` but found "${fieldTok.raw}"` : ''}`,
        fieldTok
      );
    }
    const field = fieldTok.value;

    // Bare-word keyword term: a word NOT followed by an operator / IS / IN /
    // NOT IN is a free-text search across all searchable fields.
    //   AAPL.OQ OR MSFT.N   ->  keyword(AAPL.OQ) OR keyword(MSFT.N)
    const t = this.peek();
    const followsOp = t && (
      t.type === TOKEN.OPERATOR ||
      (t.type === TOKEN.KEYWORD && (
        t.value === 'IS' || t.value === 'IN' ||
        (t.value === 'NOT' && this.peek(1) && this.peek(1).type === TOKEN.KEYWORD && this.peek(1).value === 'IN')
      ))
    );
    if (!followsOp) {
      return { type: 'clause', op: 'keyword', value: field, valueKind: TOKEN.FIELD, fieldToken: fieldTok };
    }

    // field IS [NOT] EMPTY|NULL
    if (t.type === TOKEN.KEYWORD && t.value === 'IS') {
      this.next();
      let negated = false;
      let k = this.next();
      if (k && k.type === TOKEN.KEYWORD && k.value === 'NOT') { negated = true; k = this.next(); }
      if (!k || k.type !== TOKEN.KEYWORD || (k.value !== 'EMPTY' && k.value !== 'NULL')) {
        throw new ParseError('Expected EMPTY or NULL after IS', k);
      }
      return { type: 'clause', field, op: negated ? 'is_not_empty' : 'is_empty', mode: k.value, fieldToken: fieldTok };
    }

    // field [NOT] IN ( ... )
    let negatedIn = false;
    let inTok = t;
    if (t.type === TOKEN.KEYWORD && t.value === 'NOT') {
      const after = this.peek(1);
      if (after && after.type === TOKEN.KEYWORD && after.value === 'IN') {
        this.next();
        negatedIn = true;
        inTok = this.peek();
      } else {
        throw new ParseError('Expected IN after NOT', after);
      }
    }
    if (inTok && inTok.type === TOKEN.KEYWORD && inTok.value === 'IN') {
      this.next();
      this.expect(TOKEN.LPAREN);
      const values = [];
      for (;;) {
        const v = this.next();
        if (!v || (v.type !== TOKEN.STRING && v.type !== TOKEN.NUMBER && v.type !== TOKEN.FIELD)) {
          throw new ParseError('Expected a value inside IN (...)', v);
        }
        values.push({ value: v.value, kind: v.type });
        const c = this.peek();
        if (c && c.type === TOKEN.COMMA) { this.next(); continue; }
        break;
      }
      this.expect(TOKEN.RPAREN);
      return { type: 'clause', field, op: negatedIn ? 'not_in' : 'in', values, fieldToken: fieldTok };
    }

    // field <op> value
    if (t.type !== TOKEN.OPERATOR) {
      throw new ParseError(`Expected an operator after "${field}" but found "${t.raw}"`, t);
    }
    this.next();
    const v = this.next();
    if (!v || (v.type !== TOKEN.STRING && v.type !== TOKEN.NUMBER && v.type !== TOKEN.FIELD)) {
      throw new ParseError(`Expected a value after "${t.value}"`, v);
    }
    return { type: 'clause', field, op: t.value, value: v.value, valueKind: v.type, fieldToken: fieldTok };
  }
}

/**
 * Parse a JQL string into { where: AST|null, orderBy: [{field, direction}] }.
 * Throws ParseError (with .position) on invalid input.
 */
export function parseJql(input) {
  const tokens = tokenize(input);
  const bad = tokens.find((t) => t.type === TOKEN.ERROR);
  if (bad) {
    throw new ParseError(
      bad.unterminated ? 'Unterminated string literal' : `Unexpected character "${bad.raw}"`,
      bad
    );
  }
  return new Parser(tokens).parseQuery();
}

// ---------------------------------------------------------------------------
// AMPS filter builder
// ---------------------------------------------------------------------------

/**
 * Encode a human-readable column name so it can appear as a single query
 * token, URL-style: spaces (and any other unsafe char) -> %HH.
 *   "Order Status" -> "Order%20Status"
 * The field map stores this encoded form, so it resolves like any alias.
 */
export function encodeFieldName(name) {
  return String(name).replace(/[^A-Za-z0-9_.$-]/g, (c) =>
    '%' + c.charCodeAt(0).toString(16).toUpperCase().padStart(2, '0'));
}

/** AG Grid field path -> AMPS XPath identifier. "order.qty" -> "/order/qty" */
export function toAmpsPath(fieldPath) {
  return '/' + String(fieldPath).split('.').join('/');
}

function escapeAmpsString(s) {
  return String(s).replace(/'/g, "''");
}

/** Escape user text so it is matched literally inside an AMPS LIKE (PCRE) pattern. */
function escapeRegex(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNumericLiteral(v) {
  return /^-?\d+(\.\d+)?$/.test(String(v));
}

/**
 * Render a literal with type awareness.
 * fieldDef.dataType: 'number' | 'string' | 'boolean' | 'date' | undefined
 */
function renderLiteral(value, fieldDef) {
  const dataType = fieldDef && fieldDef.dataType;
  if (dataType === 'number' && isNumericLiteral(value)) return String(value);
  if (dataType === 'boolean') {
    const v = String(value).toLowerCase();
    if (v === 'true' || v === 'false') return `'${v}'`; // adjust if your topic stores real booleans
  }
  if (!dataType && isNumericLiteral(value)) return String(value); // best-effort
  return `'${escapeAmpsString(value)}'`;
}

/**
 * Compile an AST (from parseJql) into an AMPS content filter string.
 *
 * @param {object|null} ast              `where` node from parseJql()
 * @param {Map<string,object>} fieldMap  lookup: lowercase token -> fieldDef
 *        fieldDef = { field: 'order.qty', headerName: 'Quantity', dataType: 'number' }
 *        Unknown fields throw, so typos surface in the UI instead of
 *        silently producing a filter the AMPS server will reject.
 * @param {object}  [options]
 * @param {Array}   [options.keywordFields]  fieldDefs that bare keyword terms
 *        and bare comparisons (`AAPL.OQ`, `> 100`) expand across — typically
 *        the grid's VISIBLE columns. Defaults to every unique def in fieldMap.
 */
export function buildAmpsFilter(ast, fieldMap, options = {}) {
  if (!ast) return '';

  const keywordFields = (options.keywordFields && options.keywordFields.length)
    ? options.keywordFields
    : Array.from(new Set(fieldMap ? fieldMap.values() : []));

  const resolve = (name, token) => {
    const def = fieldMap && fieldMap.get(String(name).toLowerCase());
    if (!def) {
      throw new ParseError(`Unknown field "${name}" — not present in the grid's column definitions`, token);
    }
    return def;
  };

  // keyword term -> OR fan-out across searchable fields:
  //   string fields: case-insensitive contains (LIKE)
  //   number fields: equality, only when the term itself is numeric
  //   date/boolean fields: skipped (no sensible free-text match)
  const keywordClause = (value, token) => {
    const isNum = isNumericLiteral(value);
    const parts = [];
    keywordFields.forEach((d) => {
      if (d.dataType === 'number') {
        if (isNum) parts.push(`${toAmpsPath(d.field)} = ${value}`);
      } else if (d.dataType !== 'date' && d.dataType !== 'boolean') {
        parts.push(`${toAmpsPath(d.field)} LIKE '(?i)${escapeAmpsString(escapeRegex(value))}'`);
      }
    });
    if (parts.length === 0) {
      throw new ParseError(`No searchable fields can match "${value}"`, token);
    }
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  };

  // bare comparison -> fan-out across type-compatible fields:
  //   numeric literal: number fields    (> 100  ->  /qty > 100 OR /price > 100)
  //   string literal:  string fields    (> "M"  ->  lexicographic compare)
  const cmpAllClause = (node) => {
    if (node.cmp === '~') return keywordClause(node.value, node.opToken);
    if (node.cmp === '!~') return `NOT (${keywordClause(node.value, node.opToken)})`;

    const isNum = isNumericLiteral(node.value);
    const defs = keywordFields.filter((d) => (isNum ? d.dataType === 'number' : d.dataType === 'string'));
    if (defs.length === 0) {
      throw new ParseError(
        `No ${isNum ? 'numeric' : 'text'} fields available for a bare "${node.cmp}" comparison`,
        node.opToken
      );
    }
    const lit = isNum ? String(node.value) : `'${escapeAmpsString(node.value)}'`;
    const parts = defs.map((d) => `${toAmpsPath(d.field)} ${node.cmp} ${lit}`);
    return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
  };

  const walk = (node) => {
    switch (node.type) {
      case 'and':
        return node.children.map((c) => wrap(c, walk(c), 'and')).join(' AND ');
      case 'or':
        return node.children.map((c) => wrap(c, walk(c), 'or')).join(' OR ');
      case 'not':
        return `NOT (${walk(node.child)})`;
      case 'clause':
        return clause(node);
      default:
        throw new Error(`Unknown AST node: ${node.type}`);
    }
  };

  // Parenthesize child OR-groups inside AND chains (and vice versa) for safety.
  const wrap = (node, text, parent) => {
    if ((parent === 'and' && node.type === 'or') || (parent === 'or' && node.type === 'and')) {
      return `(${text})`;
    }
    return text;
  };

  const clause = (node) => {
    // Field-less clauses first — they fan out instead of resolving one field.
    if (node.op === 'keyword') return keywordClause(node.value, node.fieldToken);
    if (node.op === 'cmp_all') return cmpAllClause(node);

    const def = resolve(node.field, node.fieldToken);
    const path = toAmpsPath(def.field);

    switch (node.op) {
      case '=': case '!=': case '>': case '<': case '>=': case '<=':
        return `${path} ${node.op} ${renderLiteral(node.value, def)}`;

      case '~':
        return `${path} LIKE '(?i)${escapeAmpsString(escapeRegex(node.value))}'`;

      case '!~':
        return `NOT (${path} LIKE '(?i)${escapeAmpsString(escapeRegex(node.value))}')`;

      case 'in': {
        const parts = node.values.map((v) => `${path} = ${renderLiteral(v.value, def)}`);
        return parts.length === 1 ? parts[0] : `(${parts.join(' OR ')})`;
      }

      case 'not_in': {
        const parts = node.values.map((v) => `${path} = ${renderLiteral(v.value, def)}`);
        return `NOT (${parts.join(' OR ')})`;
      }

      case 'is_empty':
        return def.dataType === 'string' || node.mode === 'EMPTY'
          ? `(${path} IS NULL OR ${path} = '')`
          : `${path} IS NULL`;

      case 'is_not_empty':
        return def.dataType === 'string' || node.mode === 'EMPTY'
          ? `(${path} IS NOT NULL AND ${path} != '')`
          : `${path} IS NOT NULL`;

      default:
        throw new Error(`Unsupported operator: ${node.op}`);
    }
  };

  return walk(ast);
}

/** ORDER BY items -> AMPS `orderby` subscription option, e.g. "/price DESC, /symbol ASC" */
export function buildAmpsOrderBy(orderBy, fieldMap) {
  if (!orderBy || orderBy.length === 0) return '';
  return orderBy
    .map((o) => {
      const def = fieldMap && fieldMap.get(String(o.field).toLowerCase());
      if (!def) throw new ParseError(`Unknown field "${o.field}" in ORDER BY`);
      return `${toAmpsPath(def.field)} ${o.direction}`;
    })
    .join(', ');
}

/**
 * One-shot convenience: JQL string -> { ampsFilter, ampsOrderBy, ast }.
 * Throws ParseError with .position on bad input.
 */
export function jqlToAmps(input, fieldMap, options = {}) {
  const { where, orderBy } = parseJql(input);
  return {
    ampsFilter: buildAmpsFilter(where, fieldMap, options),
    ampsOrderBy: buildAmpsOrderBy(orderBy, fieldMap),
    ast: where,
  };
}

// ---------------------------------------------------------------------------
// Autocomplete context detection
// ---------------------------------------------------------------------------

export const CONTEXT = {
  FIELD: 'field',        // expecting a field name
  OPERATOR: 'operator',  // expecting an operator (or IS / IN / NOT IN)
  VALUE: 'value',        // expecting a value
  IN_LIST: 'in_list',    // inside IN ( ... )
  IS_WHAT: 'is_what',    // after IS -> EMPTY / NULL / NOT
  JOINER: 'joiner',      // expecting AND / OR / ORDER BY
  ORDER_FIELD: 'order_field',
  ORDER_DIR: 'order_dir',
};

/**
 * Determine what kind of token should come next at the caret, plus the
 * partial word being typed (for prefix filtering) and its replacement range.
 *
 * @returns {{ context, partial, replaceStart, replaceEnd, activeField }}
 *   activeField: the field name of the clause being completed (so value
 *   suggestions can be looked up per column).
 */
export function getCompletionContext(input, caret) {
  const tokens = tokenize(input);

  // The token the caret is currently touching -> the completion target.
  // "Touching" covers three click/typing positions:
  //   inside the token, at its end (typing), or right before it (click).
  const COMPLETABLE = [TOKEN.FIELD, TOKEN.KEYWORD, TOKEN.OPERATOR, TOKEN.STRING, TOKEN.NUMBER];
  let partialTok = null;
  const before = [];
  for (const t of tokens) {
    if (t.end < caret) { before.push(t); continue; }
    const inside = t.start < caret && caret <= t.end;
    const atStart = t.start === caret && caret < t.end;
    if (inside || atStart) {
      if (COMPLETABLE.includes(t.type)) {
        if (!partialTok) partialTok = t;
      } else if (inside) {
        before.push(t); // punctuation the caret sits after still shapes context
      }
    }
    // tokens fully after the caret are ignored for context purposes
  }

  // State machine over completed tokens.
  let context = CONTEXT.FIELD;
  let activeField = null;
  let parenDepth = 0;        // grouping parens
  let inList = false;        // inside IN (...)
  let afterOrderBy = false;

  for (let idx = 0; idx < before.length; idx++) {
    const t = before[idx];

    if (afterOrderBy) {
      if (t.type === TOKEN.FIELD) context = CONTEXT.ORDER_DIR;
      else if (t.type === TOKEN.KEYWORD && (t.value === 'ASC' || t.value === 'DESC')) context = CONTEXT.JOINER;
      else if (t.type === TOKEN.COMMA) context = CONTEXT.ORDER_FIELD;
      else if (t.type === TOKEN.KEYWORD && t.value === 'BY') context = CONTEXT.ORDER_FIELD;
      continue;
    }

    switch (t.type) {
      case TOKEN.FIELD:
        if (context === CONTEXT.FIELD) { activeField = t.value; context = CONTEXT.OPERATOR; }
        else if (context === CONTEXT.VALUE) context = CONTEXT.JOINER;       // bare-word value
        else if (context === CONTEXT.IN_LIST) context = CONTEXT.IN_LIST;    // value inside list
        break;

      case TOKEN.OPERATOR:
        if (context === CONTEXT.OPERATOR || context === CONTEXT.FIELD) context = CONTEXT.VALUE; // FIELD: bare comparison
        break;

      case TOKEN.STRING:
      case TOKEN.NUMBER:
        if (context === CONTEXT.VALUE) context = CONTEXT.JOINER;
        else if (context === CONTEXT.FIELD) context = CONTEXT.JOINER; // bare keyword term
        break;

      case TOKEN.KEYWORD:
        if (t.value === 'AND' || t.value === 'OR') context = CONTEXT.FIELD;
        else if (t.value === 'NOT') {
          // NOT before IN keeps operator context; NOT as boolean prefix expects a field
          const nxt = before[idx + 1];
          if (!(nxt && nxt.type === TOKEN.KEYWORD && nxt.value === 'IN')) {
            if (context !== CONTEXT.OPERATOR && context !== CONTEXT.IS_WHAT) context = CONTEXT.FIELD;
          }
        }
        else if (t.value === 'IN') context = CONTEXT.VALUE; // expects '('
        else if (t.value === 'IS') context = CONTEXT.IS_WHAT;
        else if (t.value === 'EMPTY' || t.value === 'NULL') context = CONTEXT.JOINER;
        else if (t.value === 'ORDER') { /* wait for BY */ }
        else if (t.value === 'BY') { afterOrderBy = true; context = CONTEXT.ORDER_FIELD; }
        break;

      case TOKEN.LPAREN:
        if (context === CONTEXT.VALUE) { inList = true; context = CONTEXT.IN_LIST; }
        else { parenDepth++; context = CONTEXT.FIELD; }
        break;

      case TOKEN.RPAREN:
        if (inList) { inList = false; context = CONTEXT.JOINER; }
        else { parenDepth = Math.max(0, parenDepth - 1); context = CONTEXT.JOINER; }
        break;

      case TOKEN.COMMA:
        if (inList) context = CONTEXT.IN_LIST;
        break;

      default:
        break;
    }
  }

  return {
    context,
    activeField,
    partial: partialTok ? input.slice(partialTok.start, caret) : '',
    partialType: partialTok ? partialTok.type : null,
    replaceStart: partialTok ? partialTok.start : caret,
    replaceEnd: partialTok ? partialTok.end : caret,
  };
}

export { ParseError };