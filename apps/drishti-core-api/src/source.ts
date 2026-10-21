import { BadGatewayException, ServiceUnavailableException } from "@nestjs/common";
import { createRunner, SourceError, type Fetcher, type Served } from "@drishti/shared";

const run = createRunner(); // one cache, one in-flight map, for every Fetcher in this process

/** Run a Fetcher and turn its failures into HTTP errors: no key set or the source down is a 503 carrying the hint, never a 500. */
export async function serve<Q, Raw, R>(fetcher: Fetcher<Q, Raw, R>, query: Q): Promise<Served<R>> {
  try {
    return await run(fetcher, query);
  } catch (e) {
    if (e instanceof SourceError) throw new ServiceUnavailableException(e.message);
    throw new BadGatewayException((e as Error).message);
  }
}
