// Saga pattern: a multi-step operation where each step can be undone. If step N
// fails, the steps that already succeeded are compensated in reverse order.
// This is how work that spans several systems (database row + storage object)
// stays consistent without a distributed transaction.

export type SagaStep<C> = {
  name: string
  run: (context: C) => Promise<void>
  compensate?: (context: C) => Promise<void>
}

export class SagaError extends Error {
  constructor(
    message: string,
    readonly failedStep: string,
    readonly cause: unknown,
    readonly compensationErrors: { step: string; error: unknown }[],
  ) {
    super(message)
  }
}

export async function runSaga<C>(steps: SagaStep<C>[], context: C): Promise<void> {
  const done: SagaStep<C>[] = []
  for (const step of steps) {
    try {
      await step.run(context)
      done.push(step)
    } catch (cause) {
      const compensationErrors: { step: string; error: unknown }[] = []
      for (const completed of [...done].reverse()) {
        if (!completed.compensate) continue
        try {
          await completed.compensate(context)
        } catch (error) {
          compensationErrors.push({ step: completed.name, error })
        }
      }
      throw new SagaError(`Step "${step.name}" failed`, step.name, cause, compensationErrors)
    }
  }
}
