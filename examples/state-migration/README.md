# Durable state migration

This protocol example keeps old schema renderers and migrates the latest `profile` record with compare-and-append semantics. It never rewrites prior session events. A concurrent writer causes a bounded retry, and an unknown schema stops instead of guessing.

```sh
rigyn extensions author report .
rigyn --package .
```

Run `/migrate-profile Ada`. Real packages should define a migration function for every supported stored schema, retain renderers for records that may remain in transcripts, and add restart plus conflict tests before publishing.
