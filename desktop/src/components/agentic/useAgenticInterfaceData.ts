import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type {
  AgenticInterfaceDataBinding,
  AgenticInterfaceSpec,
} from '../../../../shared/contracts/agentic-interface.ts';
import {
  fetchAgenticInterfaceData,
  type AgenticInterfaceBindingData,
} from '../../lib/api';

export type AgenticInterfaceBindingState = AgenticInterfaceBindingData & {
  loading?: boolean;
};

function bindingIds(spec: AgenticInterfaceSpec): string[] {
  return (spec.data_bindings || []).map((binding) => binding.id);
}

function bindingById(
  spec: AgenticInterfaceSpec,
  bindingId: string,
): AgenticInterfaceDataBinding | undefined {
  return spec.data_bindings?.find((binding) => binding.id === bindingId);
}

function loadingState(
  spec: AgenticInterfaceSpec,
  bindingId: string,
): AgenticInterfaceBindingState {
  const binding = bindingById(spec, bindingId);
  return {
    binding_id: bindingId,
    source: binding?.source || 'literal',
    label: binding?.label,
    status: 'skipped',
    data: null,
    refreshed_at: new Date().toISOString(),
    loading: true,
  };
}

function mergeLoadingBindings(
  current: Record<string, AgenticInterfaceBindingState>,
  spec: AgenticInterfaceSpec,
  ids: string[],
): Record<string, AgenticInterfaceBindingState> {
  const next = { ...current };
  for (const id of ids) {
    next[id] = {
      ...(next[id] || loadingState(spec, id)),
      loading: true,
      error: undefined,
    };
  }
  return next;
}

function errorBindings(
  current: Record<string, AgenticInterfaceBindingState>,
  spec: AgenticInterfaceSpec,
  ids: string[],
  message: string,
): Record<string, AgenticInterfaceBindingState> {
  const next = { ...current };
  for (const id of ids) {
    next[id] = {
      ...(next[id] || loadingState(spec, id)),
      status: 'error',
      error: message,
      loading: false,
      refreshed_at: new Date().toISOString(),
    };
  }
  return next;
}

export function useAgenticInterfaceData(spec: AgenticInterfaceSpec) {
  const mountedRef = useRef(false);
  const [bindings, setBindings] = useState<Record<string, AgenticInterfaceBindingState>>({});
  const [errors, setErrors] = useState<string[]>([]);
  const [lastRefreshedAt, setLastRefreshedAt] = useState<string | null>(null);

  const refreshBindings = useCallback(async (ids?: string[]) => {
    const targetIds = ids?.length ? ids : bindingIds(spec);
    if (targetIds.length === 0) return;

    setBindings((current) => mergeLoadingBindings(current, spec, targetIds));
    try {
      const result = await fetchAgenticInterfaceData({
        spec,
        binding_ids: ids?.length ? targetIds : undefined,
      });
      if (!mountedRef.current) return;
      setBindings((current) => {
        const next = { ...current };
        for (const id of targetIds) {
          if (!result.bindings[id] && next[id]) {
            next[id] = { ...next[id], loading: false };
          }
        }
        for (const [id, binding] of Object.entries(result.bindings)) {
          next[id] = { ...binding, loading: false };
        }
        return next;
      });
      setErrors(result.errors);
      setLastRefreshedAt(result.refreshed_at);
    } catch (err) {
      if (!mountedRef.current) return;
      const message = err instanceof Error ? err.message : 'Failed to refresh interface data';
      setErrors([message]);
      setBindings((current) => errorBindings(current, spec, targetIds, message));
    }
  }, [spec]);

  const refreshAll = useCallback(() => refreshBindings(), [refreshBindings]);
  const refreshBinding = useCallback((bindingId: string) => {
    return refreshBindings([bindingId]);
  }, [refreshBindings]);

  useEffect(() => {
    mountedRef.current = true;
    setBindings({});
    setErrors([]);
    setLastRefreshedAt(null);
    void refreshBindings();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshBindings]);

  const dataByBindingId = useMemo(() => {
    const data: Record<string, unknown> = {};
    for (const [id, binding] of Object.entries(bindings)) {
      if (binding.status === 'skipped' && binding.data === null) continue;
      data[id] = binding.data;
    }
    return data;
  }, [bindings]);

  const isLoading = useMemo(
    () => Object.values(bindings).some((binding) => binding.loading),
    [bindings],
  );

  const getBindingState = useCallback((bindingId: string) => bindings[bindingId], [bindings]);

  return {
    bindings,
    dataByBindingId,
    errors,
    getBindingState,
    isLoading,
    lastRefreshedAt,
    refreshAll,
    refreshBinding,
  };
}
