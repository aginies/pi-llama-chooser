import { describe, it, expect } from "vitest";
import {
	validateName,
	validateHost,
	validatePort,
	validateProtocol,
	validateServerArgs,
} from "../src/helper";

describe("validateName", () => {
	it("accepts valid names", () => {
		expect(validateName("my-server")).toBeNull();
		expect(validateName("server1")).toBeNull();
		expect(validateName("a")).toBeNull();
		expect(validateName("my_server")).toBeNull();
	});

	it("rejects empty names", () => {
		expect(validateName("")).toBe("Name is required.");
		expect(validateName("   ")).toBe("Name is required.");
	});

	it("rejects names with spaces", () => {
		expect(validateName("my server")).toBe("Name must not contain spaces.");
	});

	it("rejects names with __", () => {
		expect(validateName("my__server")).toBe("Name must not contain '__'.");
	});
});

describe("validateHost", () => {
	it("accepts valid IPv4 addresses", () => {
		expect(validateHost("192.168.1.1")).toBeNull();
		expect(validateHost("127.0.0.1")).toBeNull();
		expect(validateHost("0.0.0.0")).toBeNull();
	});

	it("accepts valid IPv6 addresses", () => {
		expect(validateHost("::1")).toBeNull();
		expect(validateHost("2001:db8::1")).toBeNull();
		expect(validateHost("fe80::1")).toBeNull();
	});

	it("accepts valid hostnames", () => {
		expect(validateHost("localhost")).toBeNull();
		expect(validateHost("example.com")).toBeNull();
		expect(validateHost("my-server.example.com")).toBeNull();
		expect(validateHost("a")).toBeNull();
	});

	it("rejects empty hosts", () => {
		expect(validateHost("")).toBe("Host is required.");
		expect(validateHost("   ")).toBe("Host is required.");
	});

	it("rejects hosts with spaces", () => {
		expect(validateHost("192.168.1.1 bad")).toBe("Host must not contain spaces.");
	});

	it("rejects malformed IPs", () => {
		expect(validateHost("192.168.1")).toBe("Host must be a valid IP address.");
		expect(validateHost("256.1.1.1")).toBe("Host must be a valid IP address.");
		expect(validateHost("1.2.3.4.5")).toBe("Host must be a valid IP address.");
	});

	it("rejects invalid hostnames", () => {
		expect(validateHost("-invalid.com")).toBe("Host must be a valid IP address or hostname.");
		expect(validateHost("invalid-.com")).toBe("Host must be a valid IP address or hostname.");
	});
});

describe("validatePort", () => {
	it("accepts valid ports", () => {
		expect(validatePort("8080")).toEqual({ port: 8080 });
		expect(validatePort("1")).toEqual({ port: 1 });
		expect(validatePort("65535")).toEqual({ port: 65535 });
	});

	it("rejects non-numeric ports", () => {
		expect(validatePort("abc")).toEqual({ error: "Port must be a whole number." });
		expect(validatePort("80.5")).toEqual({ error: "Port must be a whole number." });
	});

	it("rejects out-of-range ports", () => {
		expect(validatePort("-1")).toEqual({ error: "Port must be a whole number." });
		expect(validatePort("0")).toEqual({ error: "Port must be between 1 and 65535." });
		expect(validatePort("65536")).toEqual({ error: "Port must be between 1 and 65535." });
		expect(validatePort("99999")).toEqual({ error: "Port must be between 1 and 65535." });
	});

	it("rejects empty ports", () => {
		expect(validatePort("")).toEqual({ error: "Port is required." });
		expect(validatePort("   ")).toEqual({ error: "Port is required." });
	});
});

describe("validateProtocol", () => {
	it("accepts http and https", () => {
		expect(validateProtocol("http")).toBe("http");
		expect(validateProtocol("https")).toBe("https");
	});

	it("normalizes case", () => {
		expect(validateProtocol("HTTP")).toBe("http");
		expect(validateProtocol("HTTPS")).toBe("https");
		expect(validateProtocol("Http")).toBe("http");
	});

	it("rejects invalid protocols", () => {
		expect(validateProtocol("ftp")).toBeNull();
		expect(validateProtocol("ws")).toBeNull();
		expect(validateProtocol("")).toBeNull();
		expect(validateProtocol("   ")).toBeNull();
	});
});

describe("validateServerArgs", () => {
	it("accepts valid server args", () => {
		const result = validateServerArgs("my-server", "192.168.1.1", "8080", "http");
		expect(result.error).toBeUndefined();
		expect(result.server).toEqual({
			host: "192.168.1.1",
			port: 8080,
			protocol: "http",
		});
	});

	it("accepts server args with api key", () => {
		const result = validateServerArgs("my-server", "example.com", "443", "https", "secret-key");
		expect(result.error).toBeUndefined();
		expect(result.server).toEqual({
			host: "example.com",
			port: 443,
			protocol: "https",
			apiKey: "secret-key",
		});
	});

	it("rejects missing name", () => {
		const result = validateServerArgs("", "192.168.1.1", "8080", "http");
		expect(result.error).toBe("Name is required.");
		expect(result.server).toBeUndefined();
	});

	it("rejects missing host", () => {
		const result = validateServerArgs("my-server", undefined, "8080", "http");
		expect(result.error).toBe("Host is required.");
	});

	it("rejects missing port", () => {
		const result = validateServerArgs("my-server", "192.168.1.1", undefined, "http");
		expect(result.error).toBe("Port is required.");
	});

	it("rejects missing protocol", () => {
		const result = validateServerArgs("my-server", "192.168.1.1", "8080", undefined);
		expect(result.error).toBe("Protocol must be 'http' or 'https'.");
	});

	it("rejects invalid protocol", () => {
		const result = validateServerArgs("my-server", "192.168.1.1", "8080", "ftp");
		expect(result.error).toBe("Protocol must be 'http' or 'https'.");
	});

	it("trims whitespace from all fields", () => {
		const result = validateServerArgs("  my-server  ", "  192.168.1.1  ", "  8080  ", "  http  ", "  key  ");
		expect(result.error).toBeUndefined();
		expect(result.server).toEqual({
			host: "192.168.1.1",
			port: 8080,
			protocol: "http",
			apiKey: "key",
		});
	});

	it("clears empty api key", () => {
		const result = validateServerArgs("my-server", "192.168.1.1", "8080", "http", "");
		expect(result.error).toBeUndefined();
		expect(result.server?.apiKey).toBeUndefined();
	});
});
