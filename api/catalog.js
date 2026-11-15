const { categories, channels } = require("../catalog/channels.json");

const pageSize = 64;
const byCategory = new Map(categories.map(({ id }) => [id, []]));
const featured = channels.filter((channel) => channel.featured).slice(0, 12);
for (const channel of channels) {
  const memberships = new Set([channel.category_id, ...(channel.category_ids ?? [])]);
  for (const id of memberships) byCategory.get(id)?.push(channel);
}

module.exports = function catalogHandler(request, response) {
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  if (request.method !== "GET" && request.method !== "HEAD") {
    response.setHeader("Allow", "GET, HEAD");
    response.statusCode = 405;
    return response.end(JSON.stringify({ error: "method_not_allowed" }));
  }

  const { searchParams } = new URL(request.url, "http://localhost");
  const category = searchParams.get("category") ?? "";
  const entries = category === "" ? channels : byCategory.get(category);
  const requestedPage = searchParams.get("page") ?? "1";
  if (!entries || !/^[1-9][0-9]{0,6}$/.test(requestedPage)) {
    response.statusCode = 400;
    return response.end(request.method === "HEAD" ? undefined : JSON.stringify({ error: "invalid_page_query" }));
  }

  const total = entries.length;
  const page = Math.min(Number(requestedPage), Math.max(1, Math.ceil(total / pageSize)));
  const start = (page - 1) * pageSize;
  const data = {
    categories,
    channels: entries.slice(start, start + pageSize),
    category,
    page,
    page_size: pageSize,
    total
  };
  if (category === "" && page === 1) data.featured = featured;

  response.setHeader("Cache-Control", "public, max-age=60, s-maxage=60");
  response.statusCode = 200;
  response.end(request.method === "HEAD" ? undefined : JSON.stringify(data));
};
