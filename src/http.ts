import {Credentials, UrlObject} from "./configparser";
import async = require("async");
import axios, {AxiosResponse} from "axios";
import {IncomingMessage} from "http";
import {Agent as HttpsAgent} from "https";
import {AsyncFunction} from "async";

const delayPattern = /^delay\(\d+\)*$/;
const numberPattern = /\d+/;

export class ExecutionStrategy {
    static PARALLEL = async.parallel;
    static SERIES = async.series;

    static get(name: string) {
        name = name.toUpperCase();
        switch (name) {
            case "PARALLEL":
                return this.PARALLEL;
            case "SERIES":
                return this.SERIES;
            default:
                return null;
        }
    }

}

export type ErrorResponseObject = {
    error?: Error
}

export type ResponseObject = {
    response: HttpResponse,
    body: string
}

export type HttpResponse = IncomingMessage & {
    body: string
    request: any
}

export type RequestCallback = (error: Error | null, response: HttpResponse | undefined, body: string | undefined) => void;

export type BodyReplacer = {
    searchValue: string,
    replacer: string,
}

let multipleUrlExecutionStrategy = ExecutionStrategy.PARALLEL;

export function setMultipleUrlExecutionStrategy(strategyString: string) {
    const strategy = ExecutionStrategy.get(strategyString);

    if (strategy) {
        multipleUrlExecutionStrategy = strategy;
        return true;
    }
    return false;
}

export function isHttpSuccessCode(statusCode: number) {
    return Math.floor(statusCode / 100) === 2;
}

export function isHttpRedirectCode(statusCode: number) {
    return Math.floor(statusCode / 100) === 3;
}

export function httpRequest(urlObject: UrlObject, callback: RequestCallback, ...bodyReplacer: BodyReplacer[]) {
    let url = urlObject.url;
    let body = urlObject.body;
    let auth: Credentials | undefined = undefined;

    if (urlObject.auth && urlObject.auth.username && urlObject.auth.password) {
        auth = {
            username: urlObject.auth.username,
            password: urlObject.auth.password
        };

        if (typeof urlObject.auth.sendImmediately !== "undefined")
            auth.sendImmediately = urlObject.auth.sendImmediately;
    }

    bodyReplacer.forEach(replacer => {
        url = url.replace(replacer.searchValue, replacer.replacer);
        if (body) {
            body = body.replace(replacer.searchValue, replacer.replacer);
        }
    });

    const config = {
        url,
        data: body,
        method: urlObject.method || "GET",
        headers: urlObject.headers,
        timeout: urlObject.requestTimeout || 20000,
        responseType: "text" as const,
        transformResponse: [(data: string) => data],
        validateStatus: () => true,
        maxRedirects: 10,
        httpsAgent: new HttpsAgent({rejectUnauthorized: urlObject.strictSSL !== false}),
    };

    const deliverResponse = (response: AxiosResponse<string>) => {
        const legacyResponse = (
            (response.request && response.request.res) || {
                statusCode: response.status,
                statusMessage: response.statusText,
                headers: response.headers,
            }
        ) as HttpResponse;
        legacyResponse.body = response.data;
        legacyResponse.request = response.request;
        callback(null, legacyResponse, response.data);
    };

    const deliverError = (error: Error) => {
        callback(error, undefined, undefined);
    };

    const requestWithAuth = () => axios.request<string>({
        ...config,
        auth: auth && {username: auth.username!, password: auth.password!},
    });

    const initialRequest = auth && auth.sendImmediately === false
        ? axios.request<string>(config)
        : requestWithAuth();

    initialRequest.then(response => {
        const authenticateHeader = response.headers["www-authenticate"];
        const supportsBasicAuth = typeof authenticateHeader === "string"
            ? /\bbasic\b/i.test(authenticateHeader)
            : Array.isArray(authenticateHeader) && authenticateHeader.some(value => /\bbasic\b/i.test(value));

        if (auth && auth.sendImmediately === false && response.status === 401 && supportsBasicAuth) {
            requestWithAuth().then(deliverResponse, deliverError);
            return;
        }

        deliverResponse(response);
    }, deliverError);
}

export function multipleHttpRequests(urlObjectArray: UrlObject[], callback: (result: (ErrorResponseObject | ResponseObject)[]) => void) {
    if (urlObjectArray.length === 0)
        throw new Error("Empty urlObject array");

    const taskArray: AsyncFunction<HttpResponse, Error>[] = [];
    const executionCounter = [];

    for (let i = 0; i < urlObjectArray.length; i++) {
        const urlObject = urlObjectArray[i];

        if (executionCounter[i] === undefined)
            executionCounter[i] = urlObject.repeat;

        taskArray.push((callback: (error?: Error, response?: HttpResponse, body?: any) => void, delayed?: boolean) => {
            if (urlObject.url.startsWith("delay") && delayPattern.test(urlObject.url)) {
                if (multipleUrlExecutionStrategy !== ExecutionStrategy.SERIES) {
                    console.warn("There was a 'delay' method specified but execution is unaffected because of unsuitable execution strategy!");
                    callback();
                    return;
                }

                const delay = parseInt(urlObject.url.match(numberPattern)![0]);

                // execute callback from async framework => finish urlObject
                setTimeout(() => callback(), delay);
                return;
            }

            if (!delayed && urlObject.delayBeforeExecution > 0) {
                const self = arguments.callee;
                // execute the current method a second time though delayed=true
                setTimeout(() => self(callback, true), urlObject.delayBeforeExecution);
                return;
            }

            httpRequest(urlObject, (error, response, body) => callback(error || undefined, response, body));
        });

        executionCounter[i]--;
        if (executionCounter[i] > 0)
            i--; // repeat current urlObject
    }

    // (err?: E | null, results?: Array<T | undefined>): void;
    // Array<(callback: (err: null, result: {error?: E, value?: T})

    // result: export interface AsyncResultArrayCallback<T, E = Error> { (err?: E | null, results?: Array<T | undefined>): void; }
    multipleUrlExecutionStrategy(async.reflectAll(taskArray), (error: Error | null | undefined, results?: any) => {
        const callbackArray: (ErrorResponseObject | ResponseObject)[] = [];

        for (let i = 0; i < results.length; i++) {
            const element = results[i];

            if (element.error) {
                callbackArray.push({
                    error: element.error
                });
            } else if (element.value) {
                callbackArray.push({
                    response: element.value[0],
                    body: element.value[1]
                });
            }
        }

        callback(callbackArray);
    });
}
