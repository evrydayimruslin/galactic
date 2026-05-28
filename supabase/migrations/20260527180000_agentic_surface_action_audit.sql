alter table public.mcp_call_logs
  add column if not exists agentic_surface_action boolean not null default false,
  add column if not exists agentic_surface_id text,
  add column if not exists agentic_interface_id text,
  add column if not exists agentic_action_id text,
  add column if not exists agentic_turn_id text,
  add column if not exists agentic_component_id text;

create index if not exists mcp_call_logs_agentic_action_created_idx
  on public.mcp_call_logs (agentic_action_id, created_at desc)
  where agentic_surface_action = true;

create index if not exists mcp_call_logs_agentic_interface_created_idx
  on public.mcp_call_logs (agentic_interface_id, created_at desc)
  where agentic_surface_action = true;

create index if not exists mcp_call_logs_agentic_surface_turn_idx
  on public.mcp_call_logs (agentic_surface_id, agentic_turn_id)
  where agentic_surface_action = true;
