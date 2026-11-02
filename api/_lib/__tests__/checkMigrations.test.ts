import { describe, expect, it } from 'vitest'
// @ts-expect-error plain .mjs script without type declarations
import { checkMigrations, stripSqlComments } from '../../../scripts/check-migrations.mjs'

const ok = (name: string, sql = 'create index if not exists a on b (c);') => ({ name, sql })

describe('check-migrations', () => {
  it('accepts ordered, well-named migrations', () => {
    expect(checkMigrations([ok('202610100001_a.sql'), ok('202610110001_b.sql')])).toEqual([])
  })
  it('flags bad names, empty files, duplicates and wrong order', () => {
    expect(checkMigrations([ok('bad-name.sql')])[0]).toMatch(/name must look like/)
    expect(checkMigrations([ok('202610100001_a.sql', '  ')])[0]).toMatch(/empty/)
    expect(checkMigrations([ok('202610100001_a.sql'), ok('202610100001_b.sql')]).join()).toMatch(/duplicate/)
    expect(checkMigrations([ok('202610110001_b.sql'), ok('202610100001_a.sql')]).join()).toMatch(/not in timestamp order/)
  })
  it('flags destructive statements unless reviewed', () => {
    expect(checkMigrations([ok('202610100001_a.sql', 'drop table public.x;')]).join()).toMatch(/drop table/)
    expect(checkMigrations([ok('202610100001_a.sql', 'truncate public.x;')]).join()).toMatch(/truncate/)
    expect(checkMigrations([ok('202610100001_a.sql', 'delete from public.x;')]).join()).toMatch(/delete without where/)
    expect(checkMigrations([ok('202610100001_a.sql', 'delete from public.x where id = 1;')])).toEqual([])
    expect(checkMigrations([ok('202610100001_a.sql', '-- migration-safety: reviewed\ndrop table public.x;')])).toEqual([])
  })
  it('ignores destructive words inside comments', () => {
    expect(stripSqlComments('-- drop table x\nselect 1; /* truncate y */')).not.toMatch(/drop|truncate/)
    expect(checkMigrations([ok('202610100001_a.sql', '-- we never drop table here\nselect 1;')])).toEqual([])
  })
})
