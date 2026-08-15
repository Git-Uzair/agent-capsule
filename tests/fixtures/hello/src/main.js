globalThis.tools = {
  greet(args) {
    const seen = Number(capsule.kv.get("greet_count") ?? "0") + 1;
    capsule.kv.set("greet_count", String(seen));
    capsule.log("greeted " + args.name);
    return { text: "hello " + args.name, at: capsule.now(), count: seen };
  },
};
