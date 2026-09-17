# Change Log

This project adheres to [Semantic Versioning](http://semver.org/).

## 0.6.0

- Moved`{ isLoading, value }` to `{ status, value }` of Nano Stores async API.
- Added `{ error }` status to `migrateIfNeeded()` on failed migration.
- Added Web Locks to apply migration only once between browser tabs.
- Added `Transaction` type to prevent nested transactions.
- Fixed `get()` support in `toDrizzle()`.
- Fixed `?` inside quotes in `pglite` driver.
- Fixed version `0` support in `migrateIfNeeded()`.
- Fixed `migrateIfNeeded()` error message in React Native.
- Fixed refreshing stores on every changed row in `expo` driver.

## 0.5.3

- Fixed passing options to `sqlocal` driver.

## 0.5.2

- Fixed changes detection in `node` driver.

## 0.5.1

- Fixed binary columns support.

## 0.5.0

- Moved errors from `onError` option to `error` event.

## 0.4.3

- Fixed error reporting.

## 0.4.2

- Fixed error reporting.

## 0.4.1

- Fixed `Database#pause()` to stop already mounted stores.

## 0.4.0

- Added `immediate` transactions support.

## 0.3.1

- Fixed accepted types for pglite.

## 0.3.0

- Added `Database#select()`.

## 0.2.0

- Added `SqlStore#loading`.
- Added `Database#resume()` & `#pause()`.
- Added npm provenance.

## 0.1.0

- Initial release.
