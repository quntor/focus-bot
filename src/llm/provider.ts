// Тонкий адаптер провайдера модели. Продуктовый код о конкретном провайдере не
// знает: он передаёт системный промт и данные и получает строку. Что делать со
// строкой, решает код — после строгой проверки схемой (intent.ts, report.ts).
//
// Модель не получает инструментов и не может ничего сделать сама: ни начислить
// очки, ни написать в базу, ни отправить сообщение. Это обеспечено тем, что у
// неё нет канала, кроме возвращаемой строки, а не текстом системного промта.
export type LlmRequest = {
  system: string
  // Данные одного пользователя. Текст другого пользователя сюда не попадает
  // никогда: сборщики промта берут данные только по userId текущего апдейта.
  input: string
  maxTokens: number
  timeoutMs: number
}

// Ответ провайдера: строка для продукта и расход токенов для учёта вызовов.
// Расход может не прийти — тогда null, а не выдуманный ноль.
export type LlmReply = {
  text: string
  usage: { inputTokens: number; outputTokens: number } | null
}

export interface LlmProvider {
  readonly enabled: boolean
  // Имя модели для журнала вызовов; у выключенного провайдера — null.
  readonly model: string | null
  complete(req: LlmRequest): Promise<LlmReply>
}

export class LlmDisabled extends Error {
  override name = 'LlmDisabled'
}

// Ошибка вызова с машинным кодом для журнала: http_402, network, bad_response.
// Сообщение безопасно для лога — тело ответа провайдера в него не попадает.
export class LlmCallError extends Error {
  override name = 'LlmCallError'
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message)
  }
}

// Провайдер пока не выбран (скорее всего GigaChat). До тех пор оба касания идут
// по детерминированному пути — продукт должен работать и без модели.
export const disabledProvider: LlmProvider = {
  enabled: false,
  model: null,
  async complete() {
    throw new LlmDisabled()
  },
}
