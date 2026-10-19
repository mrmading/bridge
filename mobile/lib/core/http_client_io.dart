import 'package:http/http.dart' as http;

/// Native platforms stream responses out of the box.
http.Client makeClient() => http.Client();
