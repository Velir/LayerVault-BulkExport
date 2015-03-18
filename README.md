# LayerVault-BulkExport
Node app to fetch all resources from a LayerVault account

    node export user password client_id client_secret organization_id

Optional parameters:

    --maxIdsPerRequest: Configures the maximum number of IDs that can be requested at once. Too many IDs will result in a too large request. Default = 400

    --testingLimit: Configures a testing limit per item type. The exporter will only fetch up to this limit of items for each type. Note that this will likely cause some reference errors to show up on post processing, due to not all items being fetched.

    --maxConcurrentRequests: Limits the max concurrent requests for fetching file assets. Default = 10

    --skipFileAssets: Skips the file asset fetching process (Previews, Files). This is a very expensive process, so it is best to skip it when first running the exporter to make sure you have everything configured correctly. Default = false

Example:

    node export me@example.com myPassword 48d8a78c9e4e4e0ece2444deb67e9f3b3819556ca9a42102c37ed7a7ad78b456 48d8a78c9e4e4e0ece2444deb67e9f3b3819556ca9a42102c37ed7a7ad78b456 5748935 --maxIdsPerRequest 400 --testingLimit 20 --maxConcurrentRequests 10 --skipFileAssets

Exports to **./out/*current date-time***
