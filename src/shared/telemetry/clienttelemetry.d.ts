import {Request} from 'aws-sdk/lib/request';
import {Response} from 'aws-sdk/lib/response';
import {AWSError} from 'aws-sdk/lib/error';
import {Service} from 'aws-sdk/lib/service';
import {ServiceConfigurationOptions} from 'aws-sdk/lib/service';
import {ConfigBase as Config} from 'aws-sdk/lib/config';
interface Blob {}
declare class ClientTelemetry extends Service {
  /**
   * Constructs a service object. This object has one method for each API operation.
   */
  constructor(options?: ClientTelemetry.Types.ClientConfiguration)
  config: Config & ClientTelemetry.Types.ClientConfiguration;
  /**
   * 
   */
  postErrorReport(params: ClientTelemetry.Types.PostErrorReportRequest, callback?: (err: AWSError, data: {}) => void): Request<{}, AWSError>;
  /**
   * 
   */
  postErrorReport(callback?: (err: AWSError, data: {}) => void): Request<{}, AWSError>;
  /**
   * 
   */
  postMetrics(params: ClientTelemetry.Types.PostMetricsRequest, callback?: (err: AWSError, data: {}) => void): Request<{}, AWSError>;
  /**
   * 
   */
  postMetrics(callback?: (err: AWSError, data: {}) => void): Request<{}, AWSError>;
}
declare namespace ClientTelemetry {
  export type AWSProduct = "AWS Toolkit For JetBrains"|"AWS Toolkit For Eclipse"|"AWS Toolkit for VisualStudio"|string;
  export type AWSProductVersion = string;
  export type ClientID = string;
  export type Command = string;
  export type Comment = string;
  export type Datapoint = number;
  export type Email = string;
  export type EpochTimestamp = number;
  export interface ErrorDetails {
    Command: Command;
    EpochTimestamp: EpochTimestamp;
    Type: Type;
    Message?: Message;
    StackTrace: StackTrace;
  }
  export type Key = string;
  export type Message = string;
  export type Metadata = MetadataEntry[];
  export interface MetadataEntry {
    Key?: Key;
    Value?: Value;
  }
  export type MetricData = MetricDatum[];
  export interface MetricDatum {
    MetricName?: MetricName;
    EpochTimestamp?: EpochTimestamp;
    Unit?: Unit;
    Value?: Datapoint;
    Metadata?: Metadata;
  }
  export type MetricName = string;
  export interface PostErrorReportRequest {
    AWSProduct: AWSProduct;
    AWSProductVersion: AWSProductVersion;
    Metadata?: Metadata;
    Userdata?: Userdata;
    ErrorDetails: ErrorDetails;
  }
  export interface PostMetricsRequest {
    AWSProduct: AWSProduct;
    AWSProductVersion: AWSProductVersion;
    ClientID: ClientID;
    OS?: Value;
    OSVersion?: Value;
    ParentProduct?: Value;
    ParentProductVersion?: Value;
    MetricData: MetricData;
  }
  export type StackTrace = string;
  export type Type = string;
  export type Unit = "Milliseconds"|"Bytes"|"Percent"|"Count"|"None"|string;
  export interface Userdata {
    Email?: Email;
    Comment?: Comment;
  }
  export type Value = string;
  /**
   * A string in YYYY-MM-DD format that represents the latest possible API version that can be used in this service. Specify 'latest' to use the latest possible version.
   */
  export type apiVersion = "2017-07-25"|"latest"|string;
  export interface ClientApiVersions {
    /**
     * A string in YYYY-MM-DD format that represents the latest possible API version that can be used in this service. Specify 'latest' to use the latest possible version.
     */
    apiVersion?: apiVersion;
  }
  export type ClientConfiguration = ServiceConfigurationOptions & ClientApiVersions;
  /**
   * Contains interfaces for use with the ClientTelemetry client.
   */
  export import Types = ClientTelemetry;
}
export = ClientTelemetry;
