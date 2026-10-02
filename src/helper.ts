// =============================================================================
// helper.ts — input validation for llama-chooser server configuration
//
// Pure, dependency-light validators used by both the interactive menu
// (wizard prompts) and the `/llama-chooser config <subcmd>` CLI path. Each
// validator returns a human-readable error message (or null / a result object)
// so callers can surface it directly in the UI.
// =============================================================================

import net from "node:net";

/** The fields needed to address a server (a subset of LlamaServer). */
export interface ServerEndpoint {
	host: string;
	port: number;
	protocol: "http" | "https";
	/** Optional API key sent as `Authorization: Bearer <key>` for this server. */
	apiKey?: string;
}

/**
 * RFC 1123-ish hostname: dot-separated labels of 1-63 chars, alphanumeric with
 * internal hyphens, no leading/trailing hyphen, total length <= 253.
 */
const HOSTNAME_RE =
	/^(?=.{1,253}$)[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?(\.[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?)*$/i;

/** Validate a server name. Returns an error message, or null if valid. */
export function validateName(value: string): string | null {
	const name = value.trim();
	if (!name) return "Name is required.";
	if (/\s/.test(name)) return "Name must not contain spaces.";
	if (name.includes("__")) return "Name must not contain '__'.";
	return null;
}

/**
 * Validate a host: an IPv4/IPv6 literal (via node:net) or a valid hostname.
 * Returns an error message, or null if valid.
 */
export function validateHost(value: string): string | null {
	const host = value.trim();
	if (!host) return "Host is required.";
	if (/\s/.test(host)) return "Host must not contain spaces.";
	if (net.isIP(host) !== 0) return null; // valid IPv4 or IPv6
	if (HOSTNAME_RE.test(host)) return null; // valid hostname
	return "Host must be a valid IP address or hostname.";
}

/** Validate a port. Returns { port } on success, or { error } on failure. */
export function validatePort(value: string): { error?: string; port?: number } {
	const trimmed = value.trim();
	if (!trimmed) return { error: "Port is required." };
	if (!/^\d+$/.test(trimmed)) return { error: "Port must be a whole number." };
	const port = Number(trimmed);
	if (port < 1 || port > 65535) return { error: "Port must be between 1 and 65535." };
	return { port };
}

/** Validate a protocol. Returns the normalized protocol, or null if invalid. */
export function validateProtocol(value: string | undefined): "http" | "https" | null {
	const protocol = (value ?? "http").trim().toLowerCase();
	return protocol === "http" || protocol === "https" ? protocol : null;
}

/**
 * Validate all server arguments at once (used by the `/llama-chooser config`
 * CLI subcommands). Returns { server } on success, or { error } on failure.
 */
export function validateServerArgs(
	name: string,
	host: string | undefined,
	port: string | undefined,
	protocol: string | undefined,
	apiKey?: string,
): { error?: string; server?: ServerEndpoint } {
	const nameError = validateName(name);
	if (nameError) return { error: nameError };
	const trimmedHost = (host ?? "").trim();
	const hostError = validateHost(trimmedHost);
	if (hostError) return { error: hostError };
	const portResult = validatePort(port ?? "");
	if (portResult.error || portResult.port === undefined) {
		return { error: portResult.error ?? "Port is required." };
	}
	const parsedProtocol = validateProtocol(protocol);
	if (parsedProtocol === null) return { error: "Protocol must be 'http' or 'https'." };
	const trimmedKey = (apiKey ?? "").trim();
	return {
		server: {
			host: trimmedHost,
			port: portResult.port,
			protocol: parsedProtocol,
			apiKey: trimmedKey || undefined,
		},
	};
}
