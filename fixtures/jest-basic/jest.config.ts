// A TypeScript config, read with the project's own Jest as Jest itself reads it.
interface Config {
  testEnvironment: string;
  testMatch: string[];
}

const config: Config = { testEnvironment: 'node', testMatch: ['<rootDir>/src/**/*.test.ts'] };

export default config;
