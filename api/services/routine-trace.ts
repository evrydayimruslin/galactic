export interface RoutineTraceContext {
  routineId: string;
  routineRunId: string;
  traceId?: string;
}

// Keep this trace helper below the request-auth and sandbox dependency graph.
// Importing RequestCallerContext here creates a type-only cycle through
// request-auth -> sandbox-actor -> routine-trace and sandbox -> routine-trace.
// Trace extraction needs only this stable structural subset.
interface RoutineTraceCaller {
  routineActor?: RoutineTraceContext;
  routineContext?: RoutineTraceContext;
}

export function routineTraceContextFromCaller(
  caller: RoutineTraceCaller,
): RoutineTraceContext | undefined {
  // A downstream sandbox actor carries attribution without routine-actor
  // authority. Prefer that explicit context, then retain the routineActor
  // fallback for callers/tests that construct the older shape directly.
  const context = caller.routineContext;
  if (context?.routineId && context.routineRunId) {
    return {
      routineId: context.routineId,
      routineRunId: context.routineRunId,
      ...(context.traceId ? { traceId: context.traceId } : {}),
    };
  }
  const actor = caller.routineActor;
  if (!actor?.routineId || !actor.routineRunId) return undefined;
  return {
    routineId: actor.routineId,
    routineRunId: actor.routineRunId,
    ...(actor.traceId ? { traceId: actor.traceId } : {}),
  };
}

export function routineTraceMetadata(
  context: RoutineTraceContext | null | undefined,
): Record<string, unknown> {
  if (!context) return {};
  return {
    routine_id: context.routineId,
    routine_run_id: context.routineRunId,
    ...(context.traceId ? { trace_id: context.traceId } : {}),
  };
}
