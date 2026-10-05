import { describe,it,expect } from 'vitest'
import { allowedAt,midnight,repeatMinutes,nightAllowance } from './cadence.js'
import type { User } from '@prisma/client'
const user={timezone:'Europe/Moscow',morningTime:'10:00',eveningTime:'21:00',quietUntil:null} as User
const at=(s:string)=>new Date(`2026-10-05T${s}Z`)
describe('local calendar cadence',()=>{
 it('rest grows 10/30/60/120 and stays capped',()=>{expect([0,1,2,3,4,20].map(s=>repeatMinutes('break',7,s))).toEqual([10,30,60,120,120,120]);expect(repeatMinutes('work',45,8)).toBe(45);expect(repeatMinutes('morning',1,9)).toBe(60)})
 it('uses local midnight rather than work-day boundary',()=>{expect(midnight(user,at('20:30:00')).toISOString()).toBe('2026-10-05T21:00:00.000Z')})
 it('defers old work to local morning and end is exclusive',()=>{expect(allowedAt(user,{nightUntil:null},at('18:00:00'))?.toISOString()).toBe('2026-10-06T07:00:00.000Z');expect(allowedAt(user,{nightUntil:null},at('06:00:00'))).toEqual(at('07:00:00'))})
 it('only explicit night phase allowance delivers before nearest morning',()=>{const until=nightAllowance(user,at('19:00:00'));expect(until?.toISOString()).toBe('2026-10-06T07:00:00.000Z');expect(allowedAt(user,{nightUntil:until},at('20:00:00'))).toEqual(at('20:00:00'));expect(nightAllowance(user,at('08:00:00'))).toBeNull()})
 it('quiet wins over night exception and unsupported windows stay disabled',()=>{expect(allowedAt({...user,quietUntil:at('21:00:00')},{nightUntil:at('22:00:00')},at('20:00:00'))).toEqual(at('21:00:00'));expect(allowedAt({...user,morningTime:'22:00',eveningTime:'06:00'},{nightUntil:null},at('20:00:00'))).toBeNull()})
})
