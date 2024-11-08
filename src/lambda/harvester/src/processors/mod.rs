pub mod ftc;
pub mod test;

use std::{error::Error, time::{Duration, SystemTime, UNIX_EPOCH}};

use aws_sdk_dynamodb as ddb;
use ddb::types::AttributeValue;

use crate::HarvestJob;

pub struct HarvestState {
    last_harvested_match: u8,
    last_harvested_match_type: String,
}

pub trait Processor {
    async fn process(&self, ddb_client: &ddb::Client, harvest_state_table: &String, event_key: &String) -> Vec<HarvestJob>;

    #[doc(hidden)]
    async fn get_ddb_state_or_create(&self, ddb_client: &ddb::Client, harvest_state_table: &String, event_key: &String) -> Result<HarvestState, Box<dyn Error>> {
        println!("Retrieving state for {} from DDB", event_key);
        let ddb_result = ddb_client.get_item()
            .table_name(harvest_state_table)
            .key("eventKey", AttributeValue::S(event_key.to_string()))
            .send().await?;
        if let Some(item) = ddb_result.item {
            println!("State found in DDB");
            Ok(HarvestState {
                last_harvested_match: item.get("lastHarvestedMatch").unwrap().as_n().unwrap().parse().unwrap(),
                last_harvested_match_type: item.get("lastHarvestedMatchType").unwrap().as_s().unwrap().to_string(),
            })
        } else {
            println!("No state found in DDB, creating");
            let new_state = HarvestState {
                last_harvested_match: 0,
                last_harvested_match_type: String::from("None"),
            };
            self.put_ddb_state(ddb_client, harvest_state_table, event_key, &new_state).await;
            Ok(new_state)
        }
    }

    #[doc(hidden)]
    async fn put_ddb_state(&self, ddb_client: &ddb::Client, harvest_state_table: &String, event_key: &String, harvest_state: &HarvestState) {
        println!("Saving state for {} to DDB", event_key);
        let update_item_output = ddb_client.update_item()
            .table_name(harvest_state_table)
            .key("eventKey", AttributeValue::S(event_key.to_string()))
            .update_expression("SET #lm = :lm, #lmt = :lmt, #t = if_not_exists(#t, :t)")
            .expression_attribute_names("#lm", "lastHarvestedMatch")
            .expression_attribute_names("#lmt", "lastHarvestedMatchType")
            .expression_attribute_names("#t", "ttl")
            .expression_attribute_values(":lm", AttributeValue::N(harvest_state.last_harvested_match.to_string()))
            .expression_attribute_values(":lmt", AttributeValue::S(harvest_state.last_harvested_match_type.to_string()))
            .expression_attribute_values(":t", AttributeValue::N((SystemTime::now() + Duration::from_secs(7 * 24 * 60 * 60)).duration_since(UNIX_EPOCH).unwrap().as_secs().to_string()))
            .send().await;
        if update_item_output.is_err() {
            panic!("Error putting harvest state: {:?}", update_item_output);
        }
    }
}
