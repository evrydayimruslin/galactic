import type { AIRequest, AIResponse } from './ai.ts';
import type { ComputeBinding } from './compute.ts';
export type Tier = 'free' | 'fun' | 'pro' | 'scale' | 'enterprise';
export interface UserContext {
    id: string;
    email: string;
    displayName: string | null;
    avatarUrl: string | null;
    tier: Tier;
}
export interface QueryOptions {
    filter?: (value: unknown) => boolean;
    sort?: {
        field: string;
        order: 'asc' | 'desc';
    };
    limit?: number;
    offset?: number;
}
export interface QueryResult {
    key: string;
    value: unknown;
    updatedAt?: string;
}
export interface UltralightSDK {
    user: UserContext | null;
    isAuthenticated(): boolean;
    requireAuth(): UserContext;
    store(key: string, value: unknown): Promise<void>;
    load<T = unknown>(key: string): Promise<T | null>;
    remove(key: string): Promise<void>;
    list(prefix?: string): Promise<string[]>;
    query(prefix: string, options?: QueryOptions): Promise<QueryResult[]>;
    batchStore(items: Array<{
        key: string;
        value: unknown;
    }>): Promise<void>;
    batchLoad(keys: string[]): Promise<Array<{
        key: string;
        value: unknown;
    }>>;
    batchRemove(keys: string[]): Promise<void>;
    remember(key: string, value: unknown): Promise<void>;
    recall<T = unknown>(key: string): Promise<T | null>;
    ai(request: AIRequest): Promise<AIResponse>;
    compute: ComputeBinding;
}
