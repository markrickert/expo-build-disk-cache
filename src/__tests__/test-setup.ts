import { afterEach, jest, mock } from "bun:test";
import { defaultStubDevices, stubAdbDevices, stubAndroidHome } from "./stubAdb.ts";

export const mockLogger = {
	log: jest.fn(),
	debug: jest.fn(),
	info: jest.fn(),
	warn: jest.fn(),
	error: jest.fn(),
};

process.env["ANDROID_HOME"] = stubAndroidHome;
stubAdbDevices(defaultStubDevices);

afterEach(() => {
	jest.clearAllMocks();
	stubAdbDevices(defaultStubDevices);
});

mock.module("../logger.ts", () => ({
	logger: mockLogger,
}));
