'use strict';

function sanitizeDeliveryResultRecords(records) {
  return (Array.isArray(records) ? records : []).map(record => {
    const publicRecord = Object.assign({}, record || {});
    delete publicRecord.styling_qa;
    delete publicRecord.styling_zone_source;
    if (publicRecord.styling_status !== 'succeeded') {
      delete publicRecord.pre_styling_image_url;
    }
    return publicRecord;
  });
}

module.exports = { sanitizeDeliveryResultRecords };
