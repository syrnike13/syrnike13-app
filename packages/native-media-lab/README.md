# Native v2 Media Lab

This package is the independent black-box observer and local harness for issue #116. Run it from the repository root with `pnpm native-media:lab`; Docker must already be running.

The harness owns only ephemeral test resources. It never reads production LiveKit configuration, writes credentials into the repository, or imports the native engine from the observer process. The generated report is ignored by Git and stored at `artifacts/latest-report.json`.
