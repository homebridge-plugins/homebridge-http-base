import axios from "axios";
import * as nodeHttp from "http";
import {UrlObject} from "./configparser";
import {BodyReplacer, httpRequest, multipleHttpRequests} from "./http";

describe("http client", () => {
    let server: nodeHttp.Server;
    let baseUrl: string;

    beforeEach(async () => {
        server = nodeHttp.createServer((request, response) => {
            const chunks: Buffer[] = [];
            request.on("data", chunk => chunks.push(Buffer.from(chunk)));
            request.on("end", () => {
                const body = Buffer.concat(chunks).toString();

                if (request.url === "/status") {
                    response.statusCode = 418;
                    response.end("not json");
                } else if (request.url === "/auth") {
                    if (request.headers.authorization === "Basic dXNlcjpwYXNz") {
                        response.end("authenticated");
                    } else {
                        response.writeHead(401, {"www-authenticate": 'Basic realm="test"'});
                        response.end("challenge");
                    }
                } else if (request.url === "/slow") {
                    setTimeout(() => response.end("too late"), 100);
                } else {
                    response.end(`${request.method}|${request.headers["x-test"] || ""}|${body}`);
                }
            });
        });

        await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
        const address = server.address() as {port: number};
        baseUrl = `http://127.0.0.1:${address.port}`;
    });

    afterEach(async () => {
        await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
    });

    function sendRequest(urlObject: UrlObject, ...bodyReplacers: BodyReplacer[]) {
        return new Promise<{
            error: Error | null,
            response: Parameters<Parameters<typeof httpRequest>[1]>[1],
            body: string | undefined
        }>(resolve => {
            httpRequest(urlObject, (error, response, body) => resolve({error, response, body}), ...bodyReplacers);
        });
    }

    it("preserves a string body and returns non-2xx statuses in the callback tuple", async () => {
        const result = await sendRequest(new UrlObject(`${baseUrl}/status`));

        expect(result.error).toBeNull();
        expect(result.response!.statusCode).toBe(418);
        expect(result.response!.request).toBeDefined();
        expect(result.body).toBe("not json");
        expect(typeof result.body).toBe("string");
    });

    it("sends method, headers, body, and body replacements", async () => {
        const urlObject = new UrlObject(`${baseUrl}/echo`);
        urlObject.method = "POST";
        urlObject.headers = {"x-test": "sent"};
        urlObject.body = "value=before";

        const result = await sendRequest(urlObject, {searchValue: "before", replacer: "after"});

        expect(result.error).toBeNull();
        expect(result.body).toBe("POST|sent|value=after");
    });

    it("sends Basic auth immediately when configured", async () => {
        const urlObject = new UrlObject(`${baseUrl}/auth`);
        urlObject.auth.username = "user";
        urlObject.auth.password = "pass";

        const result = await sendRequest(urlObject);

        expect(result.error).toBeNull();
        expect(result.body).toBe("authenticated");
    });

    it("waits for a Basic auth challenge when sendImmediately is false", async () => {
        let attempts = 0;
        server.on("request", request => {
            if (request.url === "/auth")
                attempts++;
        });
        const urlObject = new UrlObject(`${baseUrl}/auth`);
        urlObject.auth.username = "user";
        urlObject.auth.password = "pass";
        urlObject.auth.sendImmediately = false;

        const result = await sendRequest(urlObject);

        expect(result.error).toBeNull();
        expect(result.body).toBe("authenticated");
        expect(attempts).toBe(2);
    });

    it("maps strictSSL to Axios TLS verification settings", async () => {
        const requestSpy = jest.spyOn(axios, "request").mockResolvedValue({
            status: 200,
            statusText: "OK",
            headers: {},
            data: "ok",
            request: {}
        } as any);

        try {
            await sendRequest(new UrlObject("https://example.test"));
            const config = requestSpy.mock.calls[0][0]!;
            expect((config.httpsAgent as any).options.rejectUnauthorized).toBe(false);

            requestSpy.mockClear();
            const strictUrlObject = new UrlObject("https://example.test");
            strictUrlObject.strictSSL = true;
            await sendRequest(strictUrlObject);
            expect((requestSpy.mock.calls[0][0]!.httpsAgent as any).options.rejectUnauthorized).toBe(true);
        } finally {
            requestSpy.mockRestore();
        }
    });

    it("reports transport timeouts through the callback error slot", async () => {
        const urlObject = new UrlObject(`${baseUrl}/slow`);
        urlObject.requestTimeout = 10;

        const result = await sendRequest(urlObject);

        expect(result.error).toBeInstanceOf(Error);
        expect(result.response).toBeUndefined();
        expect(result.body).toBeUndefined();
    });

    it("keeps multipleHttpRequests results for non-2xx responses", async () => {
        const results = await new Promise<any[]>(resolve => {
            multipleHttpRequests([
                new UrlObject(`${baseUrl}/status`),
                new UrlObject(`${baseUrl}/echo`)
            ], resolve);
        });

        expect(results).toHaveLength(2);
        expect(results[0].response.statusCode).toBe(418);
        expect(results[0].body).toBe("not json");
        expect(results[1].body).toBe("GET||");
    });
});
