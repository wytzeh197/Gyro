# Model catalog source

`model-catalog.json` is Gyro's committed model catalog. Desktop TypeScript and Rust checks validate it here. The private [gyro-website repository](https://github.com/wytzeh197/gyro-website) imports this document and its parser from a committed Gyro checkout, then serves it at the unchanged `https://usegyro.io/model-catalog.json` endpoint.

See [publishing and compatibility instructions](../docs/model-catalog.md). Website deployment runs in the separate repository.
