if (process.env.WSR_RELEASE_PACK_MODE !== "verified-builder") {
  throw new Error("DIRECT_SOURCE_PACK_PROHIBITED");
}
