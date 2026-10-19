import 'package:fetch_client/fetch_client.dart';
import 'package:http/http.dart' as http;

/// The default browser client buffers whole responses, which breaks SSE. fetch_client streams.
http.Client makeClient() => FetchClient(mode: RequestMode.cors, streamRequests: false);
