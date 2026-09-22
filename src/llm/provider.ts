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

export interface LlmProvider {
  readonly enabled: boolean
  complete(req: LlmRequest): Promise<string>
}

export class LlmDisabled extends Error {
  override name = 'LlmDisabled'
}

// Провайдер пока не выбран (скорее всего GigaChat). До тех пор оба касания идут
// по детерминированному пути — продукт должен работать и без модели.
export const disabledProvider: LlmProvider = {
  enabled: false,
  async complete() {
    throw new LlmDisabled()
  },
}
