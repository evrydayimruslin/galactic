import { RpcTarget, WorkerEntrypoint } from "cloudflare:workers";

export class FirstTestBinding extends WorkerEntrypoint {
  async record(effect) {
    const session = this.env.GX_TEST_SESSION.getByName(
      this.ctx.props.sessionName,
    );
    await session.record("first", effect);
  }
}

export class SecondTestBinding extends WorkerEntrypoint {
  async record(effect) {
    const session = this.env.GX_TEST_SESSION.getByName(
      this.ctx.props.sessionName,
    );
    await session.record("second", effect);
  }
}

class EphemeralSession extends RpcTarget {
  #value = 0;

  increment() {
    this.#value += 1;
  }

  value() {
    return this.#value;
  }
}

export class EphemeralSessionFactory extends WorkerEntrypoint {
  create() {
    return new EphemeralSession();
  }
}

export class EphemeralTestBinding extends WorkerEntrypoint {
  async touch() {
    await this.ctx.props.session.increment();
  }
}

async function persistentProbe(env, ctx) {
  const sessionName = "gx-test-rpc-probe";
  const session = env.GX_TEST_SESSION.getByName(sessionName);
  const first = ctx.exports.FirstTestBinding({ props: { sessionName } });
  const second = ctx.exports.SecondTestBinding({ props: { sessionName } });

  const worker = env.LOADER.load({
    compatibilityDate: "2026-03-01",
    mainModule: "probe.js",
    modules: {
      "probe.js": `
        export default {
          async fetch(_request, env) {
            await env.FIRST.record("storage.read");
            await env.SECOND.record("network.http");
            return new Response("ok");
          },
        };
      `,
    },
    env: {
      FIRST: first,
      SECOND: second,
    },
    globalOutbound: null,
  });
  const workerResponse = await worker.getEntrypoint().fetch(
    "http://internal/probe",
  );
  if (!workerResponse.ok) {
    throw new Error("dynamic probe Worker failed");
  }
  const transcript = await session.sealAndSnapshot();

  let postSealRejected = false;
  try {
    await first.record("storage.write");
  } catch (error) {
    postSealRejected = error instanceof Error &&
      error.message.includes("sealed");
  }

  await session.close();
  return Response.json({ transcript, postSealRejected });
}

async function transientProbe(ctx) {
  try {
    const factory = ctx.exports.EphemeralSessionFactory({ props: {} });
    const session = await factory.create();
    const binding = ctx.exports.EphemeralTestBinding({
      props: { session },
    });
    await binding.touch();
    return Response.json({
      rejected: false,
      value: await session.value(),
    });
  } catch (error) {
    return Response.json({
      rejected: true,
      name: error instanceof Error ? error.name : "Error",
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function reopenedProbe(env) {
  const session = env.GX_TEST_SESSION.getByName("gx-test-rpc-probe");
  const transcript = await session.sealAndSnapshot();
  await session.close();
  return Response.json({ transcript });
}

export default {
  fetch(request, env, ctx) {
    const pathname = new URL(request.url).pathname;
    if (pathname === "/persistent") return persistentProbe(env, ctx);
    if (pathname === "/reopened") return reopenedProbe(env);
    if (pathname === "/transient") return transientProbe(ctx);
    return new Response("Not found", { status: 404 });
  },
};
