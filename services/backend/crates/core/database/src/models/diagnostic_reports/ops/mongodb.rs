use bson::Document;
use futures::TryStreamExt;
use syrnike_result::{create_error, Result};

use crate::{DiagnosticReport, DiagnosticReportQuery, DiagnosticReportStatus, MongoDb};

use super::AbstractDiagnosticReports;

static COL: &str = "diagnostic_reports";

#[async_trait]
impl AbstractDiagnosticReports for MongoDb {
    async fn insert_diagnostic_report(&self, report: &DiagnosticReport) -> Result<()> {
        query!(self, insert_one, COL, report).map(|_| ())
    }

    async fn fetch_diagnostic_report(&self, id: &str) -> Result<DiagnosticReport> {
        self.col::<DiagnosticReport>(COL)
            .find_one(doc! { "_id": id })
            .await
            .map_err(|_| create_database_error!("find_one", COL))?
            .ok_or_else(|| create_error!(NotFound))
    }

    async fn fetch_diagnostic_reports(
        &self,
        query: DiagnosticReportQuery,
    ) -> Result<Vec<DiagnosticReport>> {
        let before = query.before.clone();
        let limit = query.limit.clamp(1, 100) as i64;
        let mut filter = query_filter(query)?;

        if let Some(before_id) = before {
            let Some(before_entry) = self
                .col::<DiagnosticReport>(COL)
                .find_one(doc! { "_id": before_id })
                .await
                .map_err(|_| create_database_error!("find_one", COL))?
            else {
                return Ok(Vec::new());
            };
            filter = doc! {
                "$and": [
                    filter,
                    {
                        "$or": [
                            { "created_at": { "$lt": before_entry.created_at as i64 } },
                            { "created_at": before_entry.created_at as i64, "_id": { "$lt": before_entry.id } }
                        ]
                    }
                ]
            };
        }

        self.col::<DiagnosticReport>(COL)
            .find(filter)
            .sort(doc! { "created_at": -1_i32, "_id": -1_i32 })
            .limit(limit)
            .await
            .map_err(|_| create_database_error!("find", COL))?
            .try_collect()
            .await
            .map_err(|_| create_database_error!("collect", COL))
    }

    async fn update_diagnostic_report(
        &self,
        id: &str,
        status: DiagnosticReportStatus,
        notes: String,
    ) -> Result<()> {
        let status =
            bson::to_bson(&status).map_err(|_| create_database_error!("serialize", COL))?;
        let result = self
            .col::<Document>(COL)
            .update_one(
                doc! { "_id": id },
                doc! { "$set": { "status": status, "notes": notes } },
            )
            .await
            .map_err(|_| create_database_error!("update_one", COL))?;
        if result.matched_count == 0 {
            Err(create_error!(NotFound))
        } else {
            Ok(())
        }
    }

    async fn fetch_expired_diagnostic_reports(&self, now: u64) -> Result<Vec<DiagnosticReport>> {
        self.col::<DiagnosticReport>(COL)
            .find(doc! { "expires_at": { "$lte": now as i64 } })
            .limit(100)
            .await
            .map_err(|_| create_database_error!("find", COL))?
            .try_collect()
            .await
            .map_err(|_| create_database_error!("collect", COL))
    }

    async fn delete_diagnostic_report(&self, id: &str) -> Result<()> {
        query!(self, delete_one_by_id, COL, id).map(|_| ())
    }
}

fn query_filter(query: DiagnosticReportQuery) -> Result<Document> {
    let mut filter = Document::new();
    if let Some(value) = query.user_id {
        filter.insert("user_id", value);
    }
    if let Some(value) = query.source {
        filter.insert("source", value);
    }
    if let Some(value) = query.release_channel {
        filter.insert("release_channel", value);
    }
    if let Some(value) = query.area {
        filter.insert("area", value);
    }
    if let Some(value) = query.trigger_code {
        filter.insert("trigger_code", value);
    }
    if let Some(value) = query.status {
        filter.insert(
            "status",
            bson::to_bson(&value).map_err(|_| create_database_error!("serialize", COL))?,
        );
    }
    Ok(filter)
}
