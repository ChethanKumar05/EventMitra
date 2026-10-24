import { httpError } from '../utils/httpError';
import { QueryResultRow } from 'pg';
import { pool } from '../config/database';
import { ListQuery, Pagination, PaginatedResult } from '../types/list';

// SQL fragments/column names are supplied only by service code; all client values are bound.
export class ListFilters {
  readonly values: unknown[] = [];
  private readonly clauses: string[] = [];
  bind(value: unknown): string { this.values.push(value); return `$${this.values.length}`; }
  add(sql: string): void { this.clauses.push(sql); }
  equal(column: string, value: string | boolean | undefined, ignoreCase = false): void {
    if (value === undefined) return;
    const parameter = this.bind(value);
    this.add(ignoreCase ? `lower(${column})=lower(${parameter})` : `${column}=${parameter}`);
  }
  search(columns: string[], value: string | undefined): void {
    if (!value) return;
    const parameter = this.bind(value);
    // Literal substring search: %, _ and backslash are ordinary search characters.
    this.add(`(${columns.map(column => `strpos(lower(${column}),lower(${parameter}))>0`).join(' OR ')})`);
  }
  get where(): string { return this.clauses.length ? `WHERE ${this.clauses.join(' AND ')}` : ''; }
}
export async function paginatedQuery<T extends QueryResultRow>(table: string, columns: string, order: string, filters: ListFilters, pagination: Pagination, from?: string): Promise<PaginatedResult<T>> {
  const { page, limit } = pagination;
  const values = [...filters.values, limit, (page - 1) * limit];
  // A single statement gives count and page the same PostgreSQL snapshot and filters.
  const result = await pool.query<{ items: T[]; total: number }>(`WITH matching AS (
      SELECT ${columns} FROM ${from ?? `public.${table} r`} ${filters.where}
    ), page_items AS (
      SELECT * FROM matching ORDER BY ${order} LIMIT $${values.length - 1} OFFSET $${values.length}
    ) SELECT (SELECT count(*)::int FROM matching) AS total,
      coalesce((SELECT json_agg(page_items ORDER BY ${order}) FROM page_items),'[]'::json) AS items`, values);
  const { items, total } = result.rows[0]!;
  const totalPages = Math.ceil(total / limit);
  return { items, total, page, limit, totalPages, hasNextPage: page < totalPages, hasPreviousPage: page > 1 };
}

export function applySearch(filters: ListFilters, query: ListQuery, columns: Record<string,string>): void {
  const selected=query.search_column;
  if (selected && selected!=='all' && !columns[selected]) httpError(400,'Invalid search_column');
  filters.search((selected && selected!=='all' ? [columns[selected]!] : Object.values(columns)).map(column=>`(${column})::text`),query.search);
}
export function listOrder(query: ListQuery, allowed: readonly string[], fallback: string, id: string): string {
  if (!query.sort_by) return query.sort_order ? `"${id}" ${query.sort_order==='desc'?'DESC':'ASC'}` : fallback;
  if (!allowed.includes(query.sort_by) || (query.sort_order && !['asc','desc'].includes(query.sort_order))) httpError(400,'Invalid sorting');
  return `"${query.sort_by}" ${query.sort_order==='desc'?'DESC':'ASC'} NULLS LAST`+(query.sort_by===id?'':`, "${id}" ASC`);
}
