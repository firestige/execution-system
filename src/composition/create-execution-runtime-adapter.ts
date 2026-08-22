import type { ExecutionRuntimeAdapter } from "../execution/runtime-adapter.js";
import { RunnerCoordinator, type RunnerCoordinatorOptions } from "../coordinator/runner-coordinator.js";
import { compileRunnerActivation } from "../interpreter/compile-runner-activation.js";

export type ExecutionRuntimeComposition = Omit<RunnerCoordinatorOptions, "compiler">;

export function createExecutionRuntimeAdapter(options: ExecutionRuntimeComposition): ExecutionRuntimeAdapter {
  const coordinator = new RunnerCoordinator({ ...options, compiler: compileRunnerActivation });
  return Object.freeze({
    execute: coordinator.execute.bind(coordinator),
    inspect: coordinator.inspect.bind(coordinator),
    cancel: coordinator.cancel.bind(coordinator),
  });
}
