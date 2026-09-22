import { afterEach, describe, expect, it } from 'vitest'
import { log, setLogSink } from './log.js'

const lines: string[] = []
setLogSink((line) => lines.push(line))
afterEach(() => {
  lines.length = 0
})

describe('лог', () => {
  it('не пропускает человеческий текст ни в поле, ни в имени события', () => {
    log.info('session_started', { task: 'написать Кате про увольнение', note: 'finish the report today' })
    log.info('написать Кате')
    const out = lines.join('\n')
    expect(out).not.toContain('Кате')
    expect(out).not.toContain('report today')
    expect(out).toContain('[redacted]')
  })

  it('берёт у ошибки класс и код, но не сообщение', () => {
    let error: unknown
    try {
      JSON.parse('{"text":"разобрать анализы"')
    } catch (e) {
      error = e
    }
    log.error('update_failed', error)
    const secretish = Object.assign(new Error('token 123:ABC leaked'), { code: 'P2002' })
    log.error('db_failed', secretish)
    const out = lines.join('\n')
    expect(out).not.toContain('анализы')
    expect(out).not.toContain('123:ABC')
    expect(out).toContain('SyntaxError')
    expect(out).toContain('P2002')
  })
})
