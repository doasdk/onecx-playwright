type Chromium = {
  launchPersistentContext: (...args: any[]) => Promise<any>;
};
type Context<T extends Chromium> = Awaited<
  ReturnType<T["launchPersistentContext"]>
>;
type Page<T extends Chromium> = ReturnType<Context<T>["pages"]>[number];
type Environment = Record<string, string | undefined>;

export function initializeAgentReport(options: {
  configPath: string;
  env?: Environment;
}): Promise<void>;

export function createLiveBrowser<T extends Chromium>(options: {
  chromium: T;
  contextOptions?: Parameters<T["launchPersistentContext"]>[1];
  env?: Environment;
}): Promise<{
  page: Page<T>;
  context: Context<T>;
  cdpEndpoint: string;
  close(): Promise<void>;
}>;

export function runBrowserAgent(options: {
  page: {
    url(): string;
    isClosed(): boolean;
    context(): unknown;
  };
  cdpEndpoint: string;
  configPath: string;
  env?: Environment;
  secrets?: string[];
}): Promise<0 | 1>;

type MediaPage<Locator> = {
  screencast: {
    start(options: {
      path: string;
      size: { width: number; height: number };
    }): Promise<void>;
    stop(): Promise<void>;
  };
  locator(selector: string): Locator;
  screenshot(options: {
    type: "png";
    fullPage: boolean;
    mask: Locator[];
  }): Promise<Buffer>;
};
type MediaTestInfo = {
  outputPath(name: string): string;
  attach(
    name: string,
    options: { body?: Buffer; path?: string; contentType: string },
  ): Promise<void>;
};
export function recordAssessment<Locator>(
  page: MediaPage<Locator>,
  testInfo: MediaTestInfo,
  assess: () => Promise<void>,
): Promise<void>;

type Live<T extends Chromium> = Awaited<
  ReturnType<typeof createLiveBrowser<T>>
>;
export function createAgentFixtures<T extends Chromium>(options: {
  chromium: T;
  configPath: string;
  outputRoot: string;
}): {
  agentEnvironment(
    args: object,
    use: (env: Environment) => Promise<void>,
  ): Promise<void>;
  liveBrowser(
    args: {
      contextOptions: Parameters<T["launchPersistentContext"]>[1];
      ignoreHTTPSErrors?: boolean;
      agentEnvironment: Environment;
    },
    use: (live: Live<T>) => Promise<void>,
  ): Promise<void>;
  context(
    args: { liveBrowser: Live<T> },
    use: (context: Context<T>) => Promise<void>,
  ): Promise<void>;
  page(
    args: { liveBrowser: Live<T> },
    use: (page: Page<T>) => Promise<void>,
  ): Promise<void>;
};
