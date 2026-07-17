import { describe, expect, it, vi } from "vitest";
import type { DnsResolver } from "../src/validate";
import { UrlValidationError, validatePublicUrl } from "../src/validate";

// Default test resolver: hostname resolves to nothing (allowed). IP-literal
// cases never reach DNS, so this keeps tests offline either way.
const emptyResolver: DnsResolver = async () => [];

const expectRejected = async (input: string, resolver: DnsResolver = emptyResolver) => {
  await expect(validatePublicUrl(input, resolver)).rejects.toThrow(UrlValidationError);
};

const expectAllowed = async (input: string, resolver: DnsResolver = emptyResolver) => {
  await expect(validatePublicUrl(input, resolver)).resolves.toBeInstanceOf(URL);
};

describe("validatePublicUrl", () => {
  describe("scheme", () => {
    it("allows http and https", async () => {
      await expectAllowed("https://example.com/article");
      await expectAllowed("http://example.com/");
    });

    it("rejects other schemes", async () => {
      await expectRejected("ftp://example.com/");
      await expectRejected("file:///etc/passwd");
      await expectRejected("javascript:alert(1)");
      await expectRejected("gopher://example.com/");
    });

    it("rejects unparseable input", async () => {
      await expectRejected("not a url");
      await expectRejected("");
      await expectRejected("example.com/no-scheme");
    });
  });

  describe("forbidden hostnames", () => {
    it("rejects localhost variants", async () => {
      await expectRejected("http://localhost/");
      await expectRejected("http://localhost:8080/");
      await expectRejected("http://LOCALHOST/");
      await expectRejected("http://localhost./");
      await expectRejected("http://foo.localhost/");
      await expectRejected("http://metadata.google.internal/computeMetadata/v1/");
    });

    it("allows ordinary public hostnames", async () => {
      await expectAllowed("https://ja.wikipedia.org/wiki/E_Ink");
      await expectAllowed("https://sub.domain.example.co.jp/path?q=1");
    });
  });

  describe("IPv4 literals", () => {
    it("rejects loopback 127.0.0.0/8", async () => {
      await expectRejected("http://127.0.0.1/");
      await expectRejected("http://127.0.0.1:8080/admin");
      await expectRejected("http://127.255.255.254/");
    });

    it("rejects 0.0.0.0/8", async () => {
      await expectRejected("http://0.0.0.0/");
      await expectRejected("http://0.1.2.3/");
    });

    it("rejects private ranges", async () => {
      await expectRejected("http://10.0.0.1/");
      await expectRejected("http://10.255.255.255/");
      await expectRejected("http://172.16.0.1/");
      await expectRejected("http://172.31.255.255/");
      await expectRejected("http://192.168.0.1/");
      await expectRejected("http://192.168.255.255/");
    });

    it("rejects link-local / metadata range 169.254.0.0/16", async () => {
      await expectRejected("http://169.254.169.254/latest/meta-data/");
      await expectRejected("http://169.254.0.1/");
    });

    it("rejects CGNAT 100.64.0.0/10", async () => {
      await expectRejected("http://100.64.0.1/");
      await expectRejected("http://100.127.255.255/");
    });

    it("rejects benchmarking 198.18.0.0/15", async () => {
      await expectRejected("http://198.18.0.1/");
      await expectRejected("http://198.19.255.255/");
    });

    it("rejects 192.0.0.0/24", async () => {
      await expectRejected("http://192.0.0.1/");
      await expectRejected("http://192.0.0.255/");
    });

    it("rejects encoded IPv4 forms (canonicalized by the URL parser)", async () => {
      await expectRejected("http://2130706433/"); // decimal 127.0.0.1
      await expectRejected("http://0x7f000001/"); // hex 127.0.0.1
      await expectRejected("http://0177.0.0.1/"); // octal first octet
      await expectRejected("http://127.1/"); // shorthand
    });

    it("allows public IPv4 and non-private edge neighbors", async () => {
      await expectAllowed("http://1.1.1.1/");
      await expectAllowed("http://8.8.8.8/");
      await expectAllowed("http://172.15.255.255/");
      await expectAllowed("http://172.32.0.1/");
      await expectAllowed("http://169.253.1.1/");
      await expectAllowed("http://100.63.255.255/");
      await expectAllowed("http://100.128.0.1/");
      await expectAllowed("http://198.17.255.255/");
      await expectAllowed("http://198.20.0.1/");
      await expectAllowed("http://192.0.1.1/");
      await expectAllowed("http://11.0.0.1/");
      await expectAllowed("http://128.0.0.1/");
    });
  });

  describe("IPv6 literals", () => {
    it("rejects loopback and unspecified", async () => {
      await expectRejected("http://[::1]/");
      await expectRejected("http://[::1]:8080/");
      await expectRejected("http://[0:0:0:0:0:0:0:1]/");
      await expectRejected("http://[::]/");
    });

    it("rejects unique local fc00::/7", async () => {
      await expectRejected("http://[fc00::1]/");
      await expectRejected("http://[fd12:3456:789a::1]/");
      await expectRejected("http://[fdff::]/");
    });

    it("rejects link-local fe80::/10", async () => {
      await expectRejected("http://[fe80::1]/");
      await expectRejected("http://[febf::1]/");
    });

    it("rejects IPv4-mapped addresses in private ranges", async () => {
      await expectRejected("http://[::ffff:127.0.0.1]/");
      await expectRejected("http://[::ffff:10.0.0.1]/");
      await expectRejected("http://[::ffff:192.168.1.1]/");
      await expectRejected("http://[::ffff:169.254.169.254]/");
      // Pure-hex spelling of ::ffff:127.0.0.1 (WHATWG canonical form)
      await expectRejected("http://[::ffff:7f00:1]/");
      await expectRejected("http://[::ffff:c0a8:101]/"); // ::ffff:192.168.1.1
    });

    it("rejects IPv4-compatible addresses in private ranges", async () => {
      await expectRejected("http://[::7f00:1]/"); // ::127.0.0.1
      await expectRejected("http://[::a00:1]/"); // ::10.0.0.1
      await expectRejected("http://[::127.0.0.1]/");
    });

    it("rejects 6to4 addresses embedding private IPv4", async () => {
      await expectRejected("http://[2002:a00:1::]/"); // 10.0.0.1
      await expectRejected("http://[2002:7f00:1::]/"); // 127.0.0.1
      await expectRejected("http://[2002:c0a8:101::]/"); // 192.168.1.1
    });

    it("rejects NAT64 addresses embedding private IPv4", async () => {
      await expectRejected("http://[64:ff9b::a00:1]/"); // 10.0.0.1
      await expectRejected("http://[64:ff9b::7f00:1]/"); // 127.0.0.1
      await expectRejected("http://[64:ff9b::a9fe:a9fe]/"); // 169.254.169.254
    });

    it("allows embedded-IPv4 forms of public addresses", async () => {
      await expectAllowed("http://[::ffff:1.1.1.1]/");
      await expectAllowed("http://[::ffff:101:101]/");
      await expectAllowed("http://[::101:101]/"); // ::1.1.1.1
      await expectAllowed("http://[2002:101:101::]/"); // 6to4 of 1.1.1.1
      await expectAllowed("http://[64:ff9b::101:101]/"); // NAT64 of 1.1.1.1
    });

    it("allows public IPv6", async () => {
      await expectAllowed("http://[2606:4700:4700::1111]/");
      await expectAllowed("http://[2001:db8::1]/");
      await expectAllowed("http://[fec0::1]/"); // just above fe80::/10
    });
  });

  describe("DoH pre-resolution of hostnames", () => {
    it("rejects hostnames resolving to a private IPv4", async () => {
      const resolver: DnsResolver = async (_host, type) =>
        type === "A" ? ["10.0.0.5"] : [];
      await expectRejected("https://rebind.example.com/", resolver);
    });

    it("rejects hostnames resolving to the metadata IP", async () => {
      const resolver: DnsResolver = async (_host, type) =>
        type === "A" ? ["169.254.169.254"] : [];
      await expectRejected("https://metadata-alias.example.com/", resolver);
    });

    it("rejects hostnames resolving to a private IPv6 (AAAA)", async () => {
      const resolver: DnsResolver = async (_host, type) =>
        type === "AAAA" ? ["fd00::1"] : [];
      await expectRejected("https://ula.example.com/", resolver);
    });

    it("rejects if any of several answers is private", async () => {
      const resolver: DnsResolver = async (_host, type) =>
        type === "A" ? ["93.184.216.34", "192.168.1.10"] : [];
      await expectRejected("https://mixed.example.com/", resolver);
    });

    it("allows hostnames resolving only to public IPs", async () => {
      const resolver: DnsResolver = async (_host, type) =>
        type === "A" ? ["93.184.216.34"] : ["2606:2800:220:1::1"];
      await expectAllowed("https://example.com/", resolver);
    });

    it("allows the URL through when DoH fails (availability over strictness)", async () => {
      const resolver: DnsResolver = async () => {
        throw new Error("DoH unreachable");
      };
      await expectAllowed("https://example.com/", resolver);
    });

    it("does not resolve IP literals", async () => {
      const resolver = vi.fn(emptyResolver);
      await expectAllowed("http://1.1.1.1/", resolver);
      await expectRejected("http://127.0.0.1/", resolver);
      expect(resolver).not.toHaveBeenCalled();
    });
  });

  describe("return value", () => {
    it("returns the parsed URL untouched", async () => {
      const url = await validatePublicUrl("https://example.com/a?b=c#d", emptyResolver);
      expect(url.href).toBe("https://example.com/a?b=c#d");
    });
  });
});
