import type { App } from "../../shared/types/index.ts";

export const PUBLIC_APP_RESPONSE_FIELDS = [
  "id",
  "owner_id",
  "slug",
  "name",
  "description",
  "icon_url",
  "visibility",
  "download_access",
  "current_version",
  "likes",
  "dislikes",
  "total_runs",
  "category",
  "tags",
  "screenshots",
  "long_description",
  "skills_md",
  "skills_parsed",
  "created_at",
  "updated_at",
] as const satisfies readonly (keyof App)[];

export const PUBLIC_APP_SERVING_FIELDS = [
  ...PUBLIC_APP_RESPONSE_FIELDS,
  "storage_key",
  "manifest",
  "exports",
  "runtime",
  "version_metadata",
  "deployment_state",
  "hosting_suspended",
  "active_release_digest",
] as const satisfies readonly (keyof App)[];

export const PUBLIC_DISCOVERY_APP_FIELDS = [
  "id",
  "owner_id",
  "slug",
  "name",
  "description",
  "tags",
  "likes",
  "dislikes",
  "weighted_likes",
  "weighted_dislikes",
  "hosting_suspended",
  "runtime",
  "gpu_status",
] as const satisfies readonly (keyof App)[];

export type PublicAppResponse = Pick<
  App,
  (typeof PUBLIC_APP_RESPONSE_FIELDS)[number]
>;
export type PublicAppServing = Pick<
  App,
  (typeof PUBLIC_APP_SERVING_FIELDS)[number]
>;
export type PublicDiscoveryApp = Pick<
  App,
  (typeof PUBLIC_DISCOVERY_APP_FIELDS)[number]
>;

export const PUBLIC_APP_RESPONSE_SELECT = PUBLIC_APP_RESPONSE_FIELDS.join(",");
export const PUBLIC_APP_SERVING_SELECT = PUBLIC_APP_SERVING_FIELDS.join(",");
export const PUBLIC_DISCOVERY_APP_SELECT = PUBLIC_DISCOVERY_APP_FIELDS.join(
  ",",
);

function pickAppFields<Fields extends readonly (keyof App)[]>(
  app: Partial<App>,
  fields: Fields,
): Pick<App, Fields[number]> {
  const source = app as Record<string, unknown>;
  const picked = {} as Record<string, unknown>;

  for (const field of fields) {
    if (field in source) {
      picked[field] = source[field as string];
    }
  }

  return picked as Pick<App, Fields[number]>;
}

export function toPublicAppResponse(app: Partial<App>): PublicAppResponse {
  return pickAppFields(app, PUBLIC_APP_RESPONSE_FIELDS);
}
